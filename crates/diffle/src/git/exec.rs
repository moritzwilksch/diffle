//! Spawning git: the one place that does, with config overrides that keep porcelain output parseable.
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::error::GitError;

/// `diff`, `log` and `grep` are porcelain and honour the user's config. These overrides keep
/// their output in the shape the parsers expect: no colour, `a/` `b/` prefixes, and non-ASCII
/// paths written verbatim instead of C-quoted. `color.ui` does not beat a per-command
/// `color.diff`/`color.grep=always`, so those are pinned too.
pub const CONFIG_ARGS: [&str; 12] = [
    "-c",
    "color.ui=never",
    "-c",
    "color.diff=never",
    "-c",
    "color.grep=never",
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.mnemonicPrefix=false",
    "-c",
    "core.quotePath=false",
];

#[derive(Default)]
pub struct ExecOptions<'a> {
    /// Exit codes that are not errors (e.g. 1 for `diff --no-index`).
    pub ok_codes: &'a [i32],
    pub input: Option<&'a [u8]>,
    /// Merged over the inherited environment.
    pub env: &'a [(&'a str, &'a str)],
}

pub fn command(cwd: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(CONFIG_ARGS).args(args).current_dir(cwd).env("GIT_OPTIONAL_LOCKS", "0").kill_on_drop(true);
    cmd
}

fn spawn_error(args: &[&str], e: &std::io::Error) -> GitError {
    GitError {
        message: format!("git {} failed: {e}", args.join(" ")),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        code: None,
        stderr: String::new(),
    }
}

/// Runs git to completion and returns stdout; a non-zero exit outside `ok_codes` is a `GitError`.
pub async fn exec_git(cwd: &Path, args: &[&str], opts: ExecOptions<'_>) -> Result<Vec<u8>, GitError> {
    let mut cmd = command(cwd, args);
    cmd.envs(opts.env.iter().copied())
        .stdin(if opts.input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| spawn_error(args, &e))?;
    // Feed stdin while the output drains, so neither pipe fills and blocks the other.
    let feed = {
        let stdin = child.stdin.take();
        let input = opts.input.map(<[u8]>::to_vec);
        async move {
            if let (Some(mut stdin), Some(input)) = (stdin, input) {
                // A child that exits without reading its input is judged by its status, not EPIPE.
                let _ = stdin.write_all(&input).await;
            }
        }
    };
    let (output, ()) = tokio::join!(child.wait_with_output(), feed);
    let output = output.map_err(|e| spawn_error(args, &e))?;
    let code = output.status.code();
    if output.status.success() || code.is_some_and(|c| opts.ok_codes.contains(&c)) {
        return Ok(output.stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let detail =
        if stderr.trim().is_empty() { format!("exit status {}", output.status) } else { stderr.trim().to_owned() };
    Err(GitError {
        message: format!("git {} failed: {detail}", args.join(" ")),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        code,
        stderr,
    })
}

pub struct RecordOptions<'a> {
    pub ok_codes: &'a [i32],
    /// Kill the child and fail after this long.
    pub timeout: Duration,
    pub accept: Option<&'a (dyn Fn(&str) -> bool + Sync)>,
}

/// Runs git and collects newline-terminated `-z` records (two NUL fields, then the text), killing
/// the child once `max` have arrived. Streams instead of buffering so the bound holds at the
/// process boundary, not after the fact.
pub async fn exec_records(
    cwd: &Path,
    args: &[&str],
    max: usize,
    opts: RecordOptions<'_>,
) -> Result<Vec<String>, GitError> {
    let mut child = command(cwd, args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| spawn_error(args, &e))?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let collect = async {
        let mut records = Vec::new();
        let mut pending = Vec::new();
        let mut fields = 0;
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let n = stdout.read(&mut chunk).await?;
            if n == 0 {
                return Ok::<_, std::io::Error>((records, false));
            }
            for &byte in &chunk[..n] {
                if byte == 0 {
                    fields += 1;
                }
                // Git grep terminates path and line with NUL; filenames may themselves contain newlines.
                if byte != b'\n' || fields < 2 {
                    pending.push(byte);
                    continue;
                }
                let record = String::from_utf8_lossy(&pending).into_owned();
                pending.clear();
                fields = 0;
                if opts.accept.is_some_and(|accept| !accept(&record)) {
                    continue;
                }
                records.push(record);
                if records.len() == max {
                    return Ok((records, true));
                }
            }
        }
    };
    // Its own task: stderr closes only once git exits, which a capped search does not wait for.
    let drain = tokio::spawn(async move {
        let mut err = Vec::new();
        let _ = stderr.read_to_end(&mut err).await;
        err
    });
    let Ok(collected) = tokio::time::timeout(opts.timeout, collect).await else {
        let _ = child.kill().await;
        return Err(GitError {
            message: format!("git {} timed out after {}ms", args.join(" "), opts.timeout.as_millis()),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            code: None,
            stderr: String::new(),
        });
    };
    let (records, done) = collected.map_err(|e| spawn_error(args, &e))?;
    if done {
        let _ = child.kill().await;
        return Ok(records);
    }
    let status = child.wait().await.map_err(|e| spawn_error(args, &e))?;
    let code = status.code();
    if status.success() || code.is_some_and(|c| opts.ok_codes.contains(&c)) {
        return Ok(records);
    }
    let stderr = String::from_utf8_lossy(&drain.await.unwrap_or_default()).into_owned();
    Err(GitError {
        message: format!("git {} failed: {}", args.join(" "), stderr.trim()),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        code,
        stderr,
    })
}

/// NUL-separated fields, without the empty one a trailing NUL leaves.
pub fn split_z(buf: &[u8]) -> Vec<String> {
    let s = String::from_utf8_lossy(buf);
    if s.is_empty() {
        return Vec::new();
    }
    let mut parts: Vec<String> = s.split('\0').map(str::to_owned).collect();
    if parts.last().is_some_and(String::is_empty) {
        parts.pop();
    }
    parts
}

pub fn text(buf: Vec<u8>) -> String {
    String::from_utf8(buf).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

//! Running a generator's command line: the stages a `|` separates, the DIFFLE_* variables, and
//! the pipe from one program's stdout to the next, with no shell in between.
use std::path::PathBuf;
use std::process::Stdio;

use tokio::io::AsyncWriteExt;

use super::runner::{FILE_VAR, Failure, failed};
use crate::error::Result;
use crate::lsp::which::find_on_path;

/// Lines of stderr kept per run.
const LOG_LINES: usize = 200;

pub(super) struct Vars {
    pub(super) root: String,
    pub(super) old: PathBuf,
    pub(super) new: PathBuf,
    pub(super) out: PathBuf,
    pub(super) file: Option<String>,
}

impl Vars {
    pub(super) fn pairs(&self) -> Vec<(&'static str, String)> {
        let mut pairs = vec![
            ("DIFFLE_ROOT", self.root.clone()),
            ("DIFFLE_OLD", self.old.to_string_lossy().into_owned()),
            ("DIFFLE_NEW", self.new.to_string_lossy().into_owned()),
            ("DIFFLE_OUT", self.out.to_string_lossy().into_owned()),
        ];
        if let Some(file) = &self.file {
            pairs.push((FILE_VAR, file.clone()));
        }
        pairs
    }

    /// `word` with every `$NAME` and `${NAME}` of the variables above substituted.
    pub(super) fn expand(&self, word: &str) -> String {
        let mut out = word.to_owned();
        for (name, value) in self.pairs() {
            out = out.replace(&format!("${{{name}}}"), &value).replace(&format!("${name}"), &value);
        }
        out
    }
}

/// The command line as stages, each a program and its arguments; a `|` word separates them.
pub(super) fn stages_of(command: &str) -> Result<Vec<Vec<String>>> {
    let words = shlex::split(command).ok_or_else(|| failed(format!("unbalanced quotes in \"{command}\"")))?;
    let stages: Vec<Vec<String>> = words.split(|w| w == "|").map(|s| s.to_vec()).collect();
    if stages.iter().any(|s| s.is_empty()) {
        return Err(failed(format!("no program named in \"{command}\"")));
    }
    Ok(stages)
}

pub(super) struct Output {
    pub(super) stdout: Vec<u8>,
    pub(super) log: Vec<String>,
}

/// Runs the stages in turn, each fed the previous one's stdout, the first `input`.
pub(super) async fn pipeline(stages: &[Vec<String>], vars: &Vars, input: Vec<u8>) -> Result<Output, Failure> {
    let mut data = input;
    let mut log = Vec::new();
    for stage in stages {
        let program = &stage[0];
        let args: Vec<String> = stage[1..].iter().map(|w| vars.expand(w)).collect();
        let resolved = find_on_path(program).ok_or_else(|| failed(format!("{program}: not on PATH")))?;
        let mut cmd = tokio::process::Command::new(resolved);
        cmd.args(&args).envs(vars.pairs()).current_dir(&vars.out);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| failed(format!("{program}: {e}")))?;
        if let Some(mut stdin) = child.stdin.take() {
            let feed = data;
            // A program that never reads stdin closes it; that is not a failure.
            tokio::spawn(async move {
                let _ = stdin.write_all(&feed).await;
                let _ = stdin.shutdown().await;
            });
        }
        let output = child.wait_with_output().await.map_err(|e| failed(format!("{program}: {e}")))?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        let name = if stages.len() > 1 { format!("{program}: ") } else { String::new() };
        log.extend(stderr.lines().map(|l| format!("{name}{l}")));
        if log.len() > LOG_LINES {
            log.drain(..log.len() - LOG_LINES);
        }
        if !output.status.success() {
            let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or_default();
            let how = output.status.code().map_or_else(|| "killed".to_owned(), |c| format!("exited {c}"));
            let message =
                format!("{program} {how}{}", if last.is_empty() { String::new() } else { format!(": {last}") });
            return Err(Failure { message, log });
        }
        data = output.stdout;
    }
    Ok(Output { stdout: data, log })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_stages_and_expands_variables() {
        let stages = stages_of("pixi-diff --before \"$DIFFLE_OLD/a b\" | md ${DIFFLE_FILE}").unwrap();
        assert_eq!(stages, [vec!["pixi-diff", "--before", "$DIFFLE_OLD/a b"], vec!["md", "${DIFFLE_FILE}"]]);
        let vars = Vars {
            root: "/r".into(),
            old: "/o".into(),
            new: "/n".into(),
            out: "/out".into(),
            file: Some("pixi.lock".into()),
        };
        assert_eq!(vars.expand(&stages[0][2]), "/o/a b");
        assert_eq!(vars.expand(&stages[1][1]), "pixi.lock");
        assert!(stages_of("a | | b").is_err());
        assert!(stages_of("a \"b").is_err());
    }
}

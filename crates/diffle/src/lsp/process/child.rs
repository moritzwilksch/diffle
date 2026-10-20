//! The operating-system side of a server: the shell that starts it, the signals that end it, and
//! how its exit reads.
#[cfg(windows)]
use std::process::Stdio;
use std::sync::Weak;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, ChildStderr};

use super::LspProcess;

/// Files the server's stderr in its log, whole lines at a time, and turns its exit into the status
/// unless diffle ended it.
pub(super) async fn watch(me: Weak<LspProcess>, mut stderr: ChildStderr, mut child: Child) {
    let mut buf = [0u8; 8192];
    let mut tail = Vec::new();
    while let Ok(n @ 1..) = stderr.read(&mut buf).await {
        tail.extend_from_slice(&buf[..n]);
        // Whole lines only, so a character split across reads stays whole.
        let Some(end) = tail.iter().rposition(|&b| b == b'\n') else { continue };
        let lines: Vec<u8> = tail.drain(..=end).collect();
        let Some(me) = me.upgrade() else { return };
        me.output.lock().unwrap().stderr(&String::from_utf8_lossy(&lines));
    }
    let Some(me) = me.upgrade() else { return };
    let status = child.wait().await;
    // The reason is recorded before the exit is announced: whoever waits on it reads it.
    if !me.state.lock().unwrap().closing {
        // A trailing partial line lands in the log, which is where the reason lives.
        me.output.lock().unwrap().stderr(&(String::from_utf8_lossy(&tail).into_owned() + "\n"));
        let how = status.map_or_else(|e| e.to_string(), |s| exit_reason(&s));
        let _ = me.fail(format!("\"{}\" exited ({how})", me.command));
    }
    me.exited.send_replace(true);
}

/// The platform shell running `command`. On unix the shell leads its own process group, so a
/// kill reaches the language server below it, not only `sh`.
pub(super) fn shell(command: &str) -> tokio::process::Command {
    #[cfg(unix)]
    {
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c").arg(command).process_group(0);
        cmd
    }
    #[cfg(windows)]
    {
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.arg("/C").raw_arg(command);
        cmd
    }
}

/// Ends the server's process tree: SIGTERM (or SIGKILL when `hard`) to its group on unix,
/// `taskkill /T /F` on Windows, where the child is cmd.exe and the server sits below it.
pub(super) fn signal(pid: u32, hard: bool) {
    #[cfg(unix)]
    unsafe {
        // SAFETY: kill(2) with a negative pid signals the group the child leads; it touches no memory.
        libc::kill(-(pid as i32), if hard { libc::SIGKILL } else { libc::SIGTERM });
    }
    #[cfg(windows)]
    {
        let _ = hard;
        let _ = std::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// An exit as the status says it: the code, or the signal's name.
pub(super) fn exit_reason(status: &std::process::ExitStatus) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            let names =
                [(1, "SIGHUP"), (2, "SIGINT"), (6, "SIGABRT"), (9, "SIGKILL"), (11, "SIGSEGV"), (15, "SIGTERM")];
            return names
                .iter()
                .find(|(n, _)| *n == sig)
                .map_or_else(|| format!("signal {sig}"), |(_, name)| (*name).to_owned());
        }
    }
    status.code().map_or_else(|| "unknown".into(), |c| c.to_string())
}

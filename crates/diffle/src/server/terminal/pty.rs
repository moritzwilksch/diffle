use std::io::{Read, Write};
use std::path::Path;

use anyhow::Context as _;
use axum::body::Bytes;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{mpsc, oneshot};

pub(super) struct Terminal {
    pub master: Box<dyn MasterPty + Send>,
    pub output: mpsc::Receiver<Vec<u8>>,
    pub input: mpsc::Sender<Bytes>,
    exit: oneshot::Receiver<i64>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl Terminal {
    pub fn open(dir: &Path, size: PtySize, startup: Option<&str>) -> anyhow::Result<Self> {
        let pair = native_pty_system().openpty(size).context("cannot open a terminal")?;
        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let mut cmd = CommandBuilder::new_default_prog();
        if let Some(startup) = startup {
            cmd = CommandBuilder::new(cmd.get_shell());
            #[cfg(unix)]
            cmd.args(["-i", "-c", startup]);
            #[cfg(windows)]
            cmd.args(["/C", startup]);
        }
        cmd.cwd(dir);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let mut child =
            pair.slave.spawn_command(cmd).with_context(|| format!("cannot start a shell in {}", dir.display()))?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let (exit_tx, exit) = oneshot::channel();
        let (out_tx, output) = mpsc::channel(32);
        let (input, mut in_rx) = mpsc::channel::<Bytes>(32);
        // PTY I/O blocks. Dedicated threads keep it off the async runtime and its shutdown pool.
        std::thread::spawn(move || {
            let mut buf = [0; 8192];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        std::thread::spawn(move || {
            while let Some(bytes) = in_rx.blocking_recv() {
                if writer.write_all(&bytes).is_err() {
                    break;
                }
            }
        });
        std::thread::spawn(move || {
            if let Ok(status) = child.wait() {
                let _ = exit_tx.send(i64::from(status.exit_code()));
            }
        });
        Ok(Self { master: pair.master, input, output, exit, killer })
    }

    pub async fn wait(&mut self) -> Option<i64> {
        (&mut self.exit).await.ok()
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        if matches!(self.exit.try_recv(), Err(oneshot::error::TryRecvError::Empty)) {
            #[cfg(unix)]
            if let Some(group) = self.master.process_group_leader().filter(|group| *group > 1) {
                // The foreground job may own a different process group from the shell.
                unsafe { libc::killpg(group, libc::SIGHUP) };
            }
            let _ = self.killer.kill();
        }
    }
}

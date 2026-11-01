//! What a server listens on: a TCP port, or a Unix socket only this user can connect to.
use std::io;

use tokio::net::TcpListener;

/// Ports tried after a taken default before giving up.
const PROBE_PORTS: u16 = 100;

/// Binds `host:port`; with `probe`, the first free port at or above `port`.
pub async fn tcp(host: &str, port: u16, probe: bool) -> io::Result<TcpListener> {
    let last = if probe { port.saturating_add(PROBE_PORTS) } else { port };
    let mut port = port;
    loop {
        match TcpListener::bind((host, port)).await {
            Err(e) if e.kind() == io::ErrorKind::AddrInUse && port < last => port += 1,
            result => return result,
        }
    }
}

/// Binds a socket at `path` that only this user may connect to. A socket nobody answers on (a
/// crashed run's) is replaced; one another server answers on, or any other file, is refused.
#[cfg(unix)]
pub async fn unix(path: &std::path::Path) -> io::Result<tokio::net::UnixListener> {
    use std::os::unix::fs::{DirBuilderExt, FileTypeExt, PermissionsExt};
    use std::path::Path;

    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
        Ok(meta) if !meta.file_type().is_socket() => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("{} exists and is not a socket", path.display()),
            ));
        }
        Ok(_) if tokio::net::UnixStream::connect(path).await.is_ok() => {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                format!("{} is in use by another server", path.display()),
            ));
        }
        Ok(_) => {}
    }
    // Bound in a private directory, restricted, then moved into place: no one else can connect in
    // between, and the rename replaces a stale socket atomically.
    let parent = match path.parent() {
        // A bare name such as `d.sock` lives in the current directory.
        Some(p) if p.as_os_str().is_empty() => Path::new("."),
        Some(p) => p,
        None => {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{} names no file", path.display())));
        }
    };
    let private = parent.join(format!(".diffle-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
    std::fs::DirBuilder::new().mode(0o700).create(&private)?;
    let staged = private.join("s");
    let bound = (|| {
        let listener = std::os::unix::net::UnixListener::bind(&staged)?;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o600))?;
        std::fs::rename(&staged, path)?;
        listener.set_nonblocking(true)?;
        Ok::<_, io::Error>(listener)
    })();
    let _ = std::fs::remove_dir_all(&private);
    tokio::net::UnixListener::from_std(bound?)
}

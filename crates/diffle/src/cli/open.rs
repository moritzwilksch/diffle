//! Opening a URL in the default browser.
use std::process::{Command, Stdio};

/// Opens `url` in the default browser, detached; a failure only says where to go instead.
pub fn open_browser(url: &str) {
    let (program, args): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else if cfg!(windows) {
        ("cmd", vec!["/c", "start", "", url])
    } else {
        ("xdg-open", vec![url])
    };
    let spawned =
        Command::new(program).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    match spawned {
        // Reaped on a thread of its own, so an opener that lingers never leaves a zombie or blocks startup.
        Ok(mut child) => drop(std::thread::spawn(move || child.wait())),
        Err(_) => crate::status!("🌐 could not open a browser; visit {url}"),
    }
}

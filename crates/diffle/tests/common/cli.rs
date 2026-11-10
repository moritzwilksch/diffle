//! The built `diffle` binary, as a user runs it: a command, or a review it serves.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};

/// The binary with its own config directory and no colours, so no real config is touched.
pub fn diffle(config: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_diffle"));
    cmd.args(args).env("NO_COLOR", "1").env("XDG_CONFIG_HOME", config).env("GIT_CONFIG_GLOBAL", no_global_config());
    cmd
}

/// A global git config that does not exist: git reads none, and every git accepts the path, where
/// conda-forge's on Windows refuses `NUL`.
pub fn no_global_config() -> std::path::PathBuf {
    std::env::temp_dir().join("diffle-tests-no-global-gitconfig")
}

pub fn run(config: &Path, args: &[&str]) -> Output {
    diffle(config, args).stdin(Stdio::null()).output().unwrap()
}

pub fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

pub fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// The version the build took from package.json.
pub fn version() -> String {
    let package = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&package).unwrap();
    json["version"].as_str().unwrap().to_owned()
}

/// Starts a review listening as `listen` says, and returns it with where it listens (the URL, or
/// `unix:<path>`) once stderr announces that and its version.
// The child goes to the caller, who stops and reaps it.
#[allow(clippy::zombie_processes)]
pub fn serve(config: &Path, repo: &Path, listen: &[&str]) -> (Child, String, BufReader<std::process::ChildStderr>) {
    let args = [&["--no-open", "--no-watch", "--no-lsp", "-C", repo.to_str().unwrap()], listen].concat();
    let mut child =
        diffle(config, &args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut lines = BufReader::new(child.stderr.take().unwrap());
    let mut line = String::new();
    let announcement = format!("🚀 diffle v{} running at ", version());
    loop {
        line.clear();
        if lines.read_line(&mut line).unwrap() == 0 {
            let _ = child.wait();
            panic!("diffle exited before serving");
        }
        if let Some(url) = line.trim().strip_prefix(&announcement) {
            return (child, url.to_owned(), lines);
        }
    }
}

/// One HTTP/1.1 request on its own connection; returns the status line and body.
pub fn http(url: &str, method: &str, path: &str, body: &str) -> (String, String) {
    let authority = url.trim_start_matches("http://").trim_end_matches('/');
    exchange(TcpStream::connect(authority).unwrap(), authority, method, path, body)
}

/// One HTTP/1.1 request on `stream`, naming `authority` as its Host.
pub fn exchange(
    mut stream: impl Read + Write,
    authority: &str,
    method: &str,
    path: &str,
    body: &str,
) -> (String, String) {
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let (head, body) = response.split_once("\r\n\r\n").unwrap_or((&response, ""));
    (head.lines().next().unwrap_or_default().to_owned(), body.to_owned())
}

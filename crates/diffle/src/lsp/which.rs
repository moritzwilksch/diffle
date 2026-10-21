//! Finding programs: the one a command line runs, where it lives on PATH, and what it really is.
use std::path::{Path, PathBuf};

/// The program a shell command line runs: its first word, unquoted. Only ever asked about plain
/// `prog arg…` lines; a command with a leading assignment or a pipeline has no single program.
pub fn argv0(command: &str) -> String {
    let s = command.trim();
    match s.chars().next() {
        Some(quote @ ('"' | '\'')) => {
            let rest = &s[1..];
            rest.find(quote).map_or(rest, |end| &rest[..end]).to_owned()
        }
        _ => s.split(char::is_whitespace).next().unwrap_or_default().to_owned(),
    }
}

/// The program as status lines and the registry name it: the basename of the first word, without a
/// Windows extension. `"C:\tools\taplo.exe" lsp stdio` → `taplo`.
pub fn program_of(command: &str) -> String {
    let prog = argv0(command);
    let base = prog.rsplit(['/', '\\']).next().filter(|b| !b.is_empty()).unwrap_or(&prog);
    let lower = base.to_lowercase();
    [".exe", ".cmd", ".bat"]
        .iter()
        .find(|ext| lower.ends_with(*ext))
        .map_or_else(|| base.to_owned(), |ext| base[..base.len() - ext.len()].to_owned())
}

/// Where `command`'s program lives, or none when it is not an executable on PATH.
pub fn find_on_path(command: &str) -> Option<PathBuf> {
    let path = std::env::var("PATH").unwrap_or_default();
    find_on_path_in(command, &path, &std::env::current_dir().ok()?)
}

/// `find_on_path` against `path_var` and `cwd`. A name with a separator is resolved against `cwd`
/// instead of searched, like a shell.
pub fn find_on_path_in(command: &str, path_var: &str, cwd: &Path) -> Option<PathBuf> {
    let prog = argv0(command);
    if prog.is_empty() {
        return None;
    }
    if prog.contains('/') || (cfg!(windows) && prog.contains('\\')) {
        // Lexically normal, as `resolve` gives it: `./gopls` names `<cwd>/gopls`.
        return executable(&cwd.join(&prog).components().collect::<PathBuf>());
    }
    std::env::split_paths(path_var)
        .filter(|dir| !dir.as_os_str().is_empty())
        .find_map(|dir| executable(&dir.join(&prog)))
}

/// `file` itself when it is a runnable file, else the first `file` + PATHEXT match on Windows, where
/// the execute bit means nothing and programs are `.exe`/`.cmd`.
fn executable(file: &Path) -> Option<PathBuf> {
    if runnable(file) {
        return Some(file.to_path_buf());
    }
    if !cfg!(windows) {
        return None;
    }
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into());
    exts.split(';')
        .filter(|e| !e.is_empty())
        .map(|ext| PathBuf::from(format!("{}{ext}", file.display())))
        .find(|f| runnable(f))
}

fn runnable(file: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(file) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

/// The file `executable` finally runs, as far as the filesystem tells: a pixi global trampoline is
/// replaced by the program its configuration names (`trampoline_configuration/<name>.json` beside
/// the launcher), then symlinks are resolved. A path that leads nowhere comes back as is.
pub fn real_executable(executable: &Path) -> PathBuf {
    let mut target = executable.to_path_buf();
    if let (Some(dir), Some(name)) = (executable.parent(), executable.file_name()) {
        let config = dir.join("trampoline_configuration").join(format!("{}.json", name.to_string_lossy()));
        let exe = std::fs::read_to_string(config)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|v| v.get("exe").and_then(|e| e.as_str()).map(str::to_owned))
            .filter(|e| !e.is_empty());
        if let Some(exe) = exe {
            target = PathBuf::from(exe);
        }
    }
    dunce::canonicalize(&target).unwrap_or(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_program_from_a_command_line_quotes_and_arguments_aside() {
        assert_eq!(argv0("gopls"), "gopls");
        assert_eq!(argv0("  pyrefly lsp  "), "pyrefly");
        assert_eq!(argv0("typescript-language-server --stdio"), "typescript-language-server");
        assert_eq!(argv0("\"/opt/my tools/pyrefly\" lsp"), "/opt/my tools/pyrefly");
        assert_eq!(argv0("'/opt/my tools/ty' server"), "/opt/my tools/ty");
        assert_eq!(argv0(""), "");
        assert_eq!(program_of("\"C:\\tools\\taplo.exe\" lsp stdio"), "taplo");
        assert_eq!(program_of("basedpyright-langserver --stdio"), "basedpyright-langserver");
    }

    fn file(at: &Path, mode: u32) {
        std::fs::write(at, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(at, std::os::unix::fs::PermissionsExt::from_mode(mode)).unwrap();
        let _ = mode;
    }

    #[test]
    fn finds_the_first_executable_on_path_and_resolves_separated_names_against_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let (bin, other) = (dir.path().join("bin"), dir.path().join("other"));
        std::fs::create_dir_all(bin.join("adirectory")).unwrap();
        std::fs::create_dir(&other).unwrap();
        file(&bin.join("gopls"), 0o755);
        file(&other.join("gopls"), 0o755);
        file(&bin.join("notexec"), 0o644);
        let path = std::env::join_paths([&bin, &other]).unwrap().into_string().unwrap();
        let find = |command: &str, path: &str, cwd: &Path| find_on_path_in(command, path, cwd);
        let cwd = dir.path();
        assert_eq!(find("gopls", &path, cwd), Some(bin.join("gopls")));
        assert_eq!(find("gopls --extra", &path, cwd), Some(bin.join("gopls")));
        assert_eq!(find("missing-server", &path, cwd), None);
        // A directory is not a program, even under the right name.
        assert_eq!(find("adirectory", &path, cwd), None);
        assert_eq!(find("", &path, cwd), None);
        assert_eq!(find("gopls", "", cwd), None);
        // Windows has no execute bit, so any regular file runs there by design.
        if cfg!(unix) {
            assert_eq!(find("notexec", &path, cwd), None);
            assert_eq!(find("./gopls lsp", &path, &bin), Some(bin.join("gopls")));
            assert_eq!(find(&other.join("gopls").to_string_lossy(), &path, &bin), Some(other.join("gopls")));
            // Relative to somewhere without it: a shell would not find it either.
            assert_eq!(find("./gopls", &path, cwd), None);
        }
    }
}

//! Minimal ANSI colours for status lines; off when stderr is not a terminal or NO_COLOR is set.
use std::io::IsTerminal;
use std::sync::LazyLock;

static COLOR: LazyLock<bool> =
    LazyLock::new(|| std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none());

fn paint(code: &str, s: &str) -> String {
    if *COLOR { format!("\u{1b}[{code}m{s}\u{1b}[0m") } else { s.to_owned() }
}

pub fn red(s: &str) -> String {
    paint("31", s)
}

pub fn green(s: &str) -> String {
    paint("32", s)
}

pub fn yellow(s: &str) -> String {
    paint("33", s)
}

pub fn cyan(s: &str) -> String {
    paint("36", s)
}

pub fn bold(s: &str) -> String {
    paint("1", s)
}

pub fn dim(s: &str) -> String {
    paint("2", s)
}

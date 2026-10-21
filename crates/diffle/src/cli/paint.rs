//! The styles of status lines. `status!` writes through anstream, which keeps them on a terminal
//! and strips them otherwise, so callers style unconditionally.
use anstyle::{AnsiColor, Style};

fn styled(style: Style, s: &str) -> String {
    format!("{style}{s}{style:#}")
}

pub fn red(s: &str) -> String {
    styled(AnsiColor::Red.on_default(), s)
}

pub fn green(s: &str) -> String {
    styled(AnsiColor::Green.on_default(), s)
}

pub fn yellow(s: &str) -> String {
    styled(AnsiColor::Yellow.on_default(), s)
}

pub fn cyan(s: &str) -> String {
    styled(AnsiColor::Cyan.on_default(), s)
}

pub fn bold(s: &str) -> String {
    styled(Style::new().bold(), s)
}

pub fn dim(s: &str) -> String {
    styled(Style::new().dimmed(), s)
}

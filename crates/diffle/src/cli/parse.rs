//! Value parsers for the command line; each failure says what was wrong, and clap makes it a usage error.
use std::sync::LazyLock;

use regex::Regex;

use crate::protocol::{LanguageId, language_ids};

fn int_arg(raw: &str, min: u32, max: u32) -> Result<u32, String> {
    let message = || format!("expected an integer between {min} and {max}");
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return Err(message());
    }
    trimmed.parse::<u32>().ok().filter(|n| (min..=max).contains(n)).ok_or_else(message)
}

pub fn port(raw: &str) -> Result<u16, String> {
    int_arg(raw, 0, 65_535).map(|n| n as u16)
}

pub fn context(raw: &str) -> Result<u32, String> {
    int_arg(raw, 0, 10_000)
}

static ORIGIN_SHAPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https?://[^/?#]+/?$").unwrap());

/// An HTTP(S) origin without credentials, a path prefix, query, or fragment, normalised.
pub fn allowed_origin(raw: &str) -> Result<String, String> {
    let invalid = || "expected an HTTP(S) origin, e.g. https://proxy.example (without a path)".to_owned();
    let url = url::Url::parse(raw).map_err(|_| invalid())?;
    let plain = matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && ORIGIN_SHAPE.is_match(raw);
    if !plain {
        return Err(invalid());
    }
    Ok(url.origin().ascii_serialization())
}

/// A language diffle knows; anything else lists the ones it does.
pub fn language(raw: &str) -> Result<LanguageId, String> {
    let wanted = raw.trim().to_lowercase();
    language_ids().into_iter().find(|id| id.to_string() == wanted).ok_or_else(|| {
        let known: Vec<String> = language_ids().iter().map(ToString::to_string).collect();
        format!("unknown language \"{raw}\"; expected one of: {}", known.join(", "))
    })
}

/// A `--lsp` value: which language to serve with which command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LspOverride {
    pub language: LanguageId,
    pub command: String,
}

/// A `--lsp <language>=<command>` value. The language must be one diffle knows, or the pair
/// reads as a command with an `=` in it and would silently serve nothing.
pub fn lsp_override(raw: &str) -> Result<LspOverride, String> {
    let Some((language_part, command)) = raw.split_once('=') else {
        return Err(format!("expected <language>=<command>, e.g. --lsp python=\"pyrefly lsp\" (got \"{raw}\")"));
    };
    Ok(LspOverride { language: language(language_part)?, command: command.trim().to_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_integers_in_range_and_rejects_the_rest() {
        assert_eq!((port("0"), port("65535"), context("12")), (Ok(0), Ok(65535), Ok(12)));
        for bad in ["nope", "", "1.5", "-1", "65536"] {
            assert_eq!(port(bad), Err("expected an integer between 0 and 65535".into()), "{bad}");
        }
        assert_eq!(context("10001"), Err("expected an integer between 0 and 10000".into()));
    }

    #[test]
    fn reads_languages_and_lsp_overrides() {
        assert_eq!(language(" Python "), Ok(LanguageId::Python));
        assert!(language("nope").unwrap_err().starts_with("unknown language \"nope\"; expected one of: astro, c,"));
        assert_eq!(
            lsp_override("python=pyrefly lsp"),
            Ok(LspOverride { language: LanguageId::Python, command: "pyrefly lsp".into() })
        );
        for bad in ["", "pyrefly lsp"] {
            assert!(lsp_override(bad).unwrap_err().starts_with("expected <language>=<command>"), "{bad}");
        }
        assert!(lsp_override("nope=x").unwrap_err().starts_with("unknown language \"nope\""));
    }

    #[test]
    fn normalises_http_origins_and_rejects_anything_else() {
        assert_eq!(allowed_origin("https://Proxy.example:443/"), Ok("https://proxy.example".into()));
        assert_eq!(allowed_origin("http://proxy.example:8080"), Ok("http://proxy.example:8080".into()));
        for bad in [
            "null",
            "*",
            "proxy.example",
            "ftp://proxy.example",
            "https://u:p@proxy.example",
            "https://proxy.example/prefix/",
            "https://proxy.example/?q=1",
            "https://proxy.example/#x",
            "https://proxy.example/prefix/..",
            "https://proxy.example?",
            "https://proxy.example#",
        ] {
            assert!(allowed_origin(bad).unwrap_err().starts_with("expected an HTTP(S) origin"), "{bad}");
        }
    }
}

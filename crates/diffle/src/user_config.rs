//! The machine-wide settings in `$XDG_CONFIG_HOME/diffle/config.json`, not per repository.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::persist::{user_config_dir, with_file_lock, write_file_atomic};
use crate::protocol::{BlameMode, FollowRefs, LanguageId, UserConfig, language_ids};

pub const TEXT_SCALES: [i64; 6] = [80, 90, 100, 110, 125, 150];
pub const FONT_SIZE_RANGE: std::ops::RangeInclusive<i64> = 8..=48;

/// Every field optional: what `set` merges in (routes' ConfigUpdate plus CLI-only lspCommands/githubHosts).
#[derive(Default, Clone, Debug)]
pub struct UserConfigPatch {
    pub auto_viewed: Option<Vec<String>>,
    pub context_lines: Option<i64>,
    pub follow_refs: Option<FollowRefs>,
    pub line_wrap: Option<bool>,
    pub blame: Option<BlameMode>,
    pub text_scale: Option<i64>,
    // An explicit null resets the override to the interface scale.
    pub editor_font_size: Option<Option<i64>>,
    pub terminal_font_size: Option<Option<i64>>,
}

impl Default for UserConfig {
    fn default() -> Self {
        Self {
            auto_viewed: Vec::new(),
            context_lines: 5,
            follow_refs: FollowRefs::Auto,
            line_wrap: true,
            blame: BlameMode::Inline,
            text_scale: 100,
            editor_font_size: None,
            terminal_font_size: None,
            lsp_commands: HashMap::new(),
            github_hosts: HashMap::new(),
        }
    }
}

/// Owns the config file. Writes are serialized, so overlapping `set`s land in call order.
pub struct UserConfigStore {
    file: PathBuf,
    config: Mutex<UserConfig>,
    writing: tokio::sync::Mutex<()>,
}

impl UserConfigStore {
    pub fn default_path() -> PathBuf {
        user_config_dir().join("config.json")
    }

    /// Reads `file`; an absent file is the defaults, and so is an unreadable one, with a warning.
    pub async fn open(file: PathBuf) -> Self {
        let config = read_config(&file).await;
        Self { file, config: Mutex::new(config), writing: tokio::sync::Mutex::new(()) }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    pub fn get(&self) -> UserConfig {
        self.config.lock().unwrap().clone()
    }

    /// Merges `next` in and persists it. A failed write fails its caller only; the next `set` still writes.
    pub async fn set(&self, next: UserConfigPatch) -> anyhow::Result<UserConfig> {
        let _turn = self.writing.lock().await;
        with_file_lock(&self.file, || async {
            let config = merge_patch(read_config(&self.file).await, next)?;
            // May hold a shell command: the write is owner-only.
            write_file_atomic(&self.file, &(serde_json::to_string_pretty(&config)? + "\n")).await?;
            *self.config.lock().unwrap() = config.clone();
            Ok(config)
        })
        .await
    }
}

async fn read_config(file: &Path) -> UserConfig {
    let result = match tokio::fs::read_to_string(file).await {
        Ok(text) => serde_json::from_str::<Value>(&text).map_err(anyhow::Error::from),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return UserConfig::default(),
        Err(e) => Err(e.into()),
    };
    match result {
        Ok(value) => normalize(&value),
        Err(e) => {
            crate::status!("[diffle] ignoring unreadable config {}: {e}", file.display());
            UserConfig::default()
        }
    }
}

fn merge_patch(config: UserConfig, next: UserConfigPatch) -> anyhow::Result<UserConfig> {
    let mut merged = serde_json::to_value(config)?;
    let fields = merged.as_object_mut().expect("config serializes to an object");
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            fields.insert(key.to_owned(), value);
        }
    };
    put("autoViewed", next.auto_viewed.map(Value::from));
    put("contextLines", next.context_lines.map(Value::from));
    put("followRefs", next.follow_refs.map(|f| Value::from(f.to_string())));
    put("lineWrap", next.line_wrap.map(Value::from));
    put("blame", next.blame.map(|b| Value::from(b.to_string())));
    put("textScale", next.text_scale.map(Value::from));
    put("editorFontSize", next.editor_font_size.map(|size| size.map_or(Value::Null, Value::from)));
    put("terminalFontSize", next.terminal_font_size.map(|size| size.map_or(Value::Null, Value::from)));
    Ok(normalize(&merged))
}

/// Whatever the file holds, as a valid config: each field that is missing or malformed takes its default.
fn normalize(value: &Value) -> UserConfig {
    let defaults = UserConfig::default();
    let empty = Map::new();
    let c = value.as_object().unwrap_or(&empty);
    let auto_viewed = match c.get("autoViewed") {
        Some(Value::Array(list)) => {
            list.iter().filter_map(Value::as_str).map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned).collect()
        }
        _ => defaults.auto_viewed,
    };
    let context_lines = c
        .get("contextLines")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .map_or(defaults.context_lines, |n| n.floor().clamp(0.0, 10_000.0) as i64);
    let follow_refs =
        c.get("followRefs").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or(defaults.follow_refs);
    let line_wrap = c.get("lineWrap").and_then(Value::as_bool).unwrap_or(defaults.line_wrap);
    let blame = c.get("blame").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or(defaults.blame);
    let int = |key| c.get(key).and_then(Value::as_i64);
    UserConfig {
        auto_viewed,
        context_lines,
        follow_refs,
        line_wrap,
        blame,
        text_scale: int("textScale").filter(|n| TEXT_SCALES.contains(n)).unwrap_or(defaults.text_scale),
        editor_font_size: int("editorFontSize").filter(|n| FONT_SIZE_RANGE.contains(n)),
        terminal_font_size: int("terminalFontSize").filter(|n| FONT_SIZE_RANGE.contains(n)),
        lsp_commands: lsp_commands(c.get("lspCommands")),
        github_hosts: github_hosts(c.get("githubHosts")),
    }
}

/// Per-language commands, keeping only languages diffle knows: a typo would otherwise sit there
/// looking effective. An empty value is kept, it turns the language off. Unknown keys are dropped
/// on the next save.
fn lsp_commands(value: Option<&Value>) -> HashMap<LanguageId, String> {
    let known = language_ids();
    let mut out = HashMap::new();
    for (language, command) in value.and_then(Value::as_object).into_iter().flatten() {
        let Some(command) = command.as_str() else { continue };
        match serde_json::from_value::<LanguageId>(Value::from(language.as_str())) {
            Ok(id) if known.contains(&id) => {
                out.insert(id, command.trim().to_owned());
            }
            _ => crate::status!("[diffle] ignoring config lspCommands.{language}: not a language diffle knows"),
        }
    }
    out
}

/// Lowercased host names; an entry without a web host is dropped, it would point nowhere.
fn github_hosts(value: Option<&Value>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (git, web) in value.and_then(Value::as_object).into_iter().flatten() {
        let host = git.trim().to_lowercase();
        if let Some(web) = web.as_str().map(str::trim).filter(|w| !w.is_empty())
            && !host.is_empty()
        {
            out.insert(host, web.to_lowercase());
        }
    }
    out
}

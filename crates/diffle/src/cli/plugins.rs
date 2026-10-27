//! The run's report generators: resolved from the catalog and the config, reported on stderr, and
//! listed by `diffle plugins`.
use super::paint::{dim, yellow};
use crate::lsp::registry::default_lookup;
use crate::reports::catalog::{Plugin, Resolution, builtins, resolve};
use crate::user_config::UserConfigStore;

/// Which generators a run starts, from the user config and PATH.
pub fn resolved(config: &UserConfigStore) -> Resolution {
    resolve(&config.get().plugins, &default_lookup())
}

/// The startup line: what will report on the diff, if anything.
pub fn report(plugins: &[Plugin]) {
    if plugins.is_empty() {
        return;
    }
    let names: Vec<String> =
        plugins.iter().map(|p| format!("{} {}", p.name, dim(&format!("({})", p.when.join(", "))))).collect();
    crate::status!("📄 {} {}", dim("reports"), names.join(", "));
}

/// `diffle plugins`: each generator a review would run and its command, then the built-in ones
/// whose programs are not on PATH, said the way the resolver decides it.
pub async fn list() -> anyhow::Result<()> {
    let store = UserConfigStore::open(UserConfigStore::default_path()).await;
    let config = store.get().plugins;
    let resolution = resolve(&config, &default_lookup());
    for p in &resolution.plugins {
        let from = if p.configured { dim(" (config)") } else { String::new() };
        println!("{} {} {}{from}", p.name, dim(&format!("[{}]", p.when.join(", "))), p.command);
    }
    for m in &resolution.missing {
        println!("{} {} {}", m.name, dim(&format!("not on PATH (tried {})", m.tried.join(", "))), dim(&m.command));
    }
    for b in builtins() {
        if config.get(&b.name).is_some_and(|c| c.command.trim().is_empty()) {
            println!("{} {}", b.name, dim("off in config"));
        }
    }
    if resolution.plugins.is_empty() && resolution.missing.is_empty() {
        crate::status!("{} no report generators", yellow("!"));
    }
    Ok(())
}

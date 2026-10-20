//! `diffle config`: the same settings as the UI dialog, from the command line.
use crate::protocol::UserConfig;
use crate::user_config::{UserConfigPatch, UserConfigStore};

use super::args::ConfigCommand;

pub async fn run(command: Option<ConfigCommand>) -> anyhow::Result<()> {
    let store = UserConfigStore::open(UserConfigStore::default_path()).await;
    let current = store.get();
    let patch = match command.unwrap_or(ConfigCommand::Show) {
        ConfigCommand::Show => {
            println!("# {}", store.file().display());
            println!("{}", serde_json::to_string_pretty(&current)?);
            return Ok(());
        }
        ConfigCommand::AddAutoViewed { globs } => {
            let mut auto_viewed = current.auto_viewed.clone();
            for glob in globs {
                if !auto_viewed.contains(&glob) {
                    auto_viewed.push(glob);
                }
            }
            UserConfigPatch { auto_viewed: Some(auto_viewed), ..Default::default() }
        }
        ConfigCommand::RemoveAutoViewed { globs } => {
            let auto_viewed = current.auto_viewed.iter().filter(|g| !globs.contains(g)).cloned().collect();
            UserConfigPatch { auto_viewed: Some(auto_viewed), ..Default::default() }
        }
        ConfigCommand::SetContext { n } => UserConfigPatch { context_lines: Some(i64::from(n)), ..Default::default() },
        ConfigCommand::SetFollowRefs { mode } => UserConfigPatch { follow_refs: Some(mode), ..Default::default() },
        ConfigCommand::SetLsp { language, command } => {
            let mut lsp_commands = current.lsp_commands.clone();
            lsp_commands.insert(language, command);
            UserConfigPatch { lsp_commands: Some(lsp_commands), ..Default::default() }
        }
        ConfigCommand::UnsetLsp { languages } => {
            let mut lsp_commands = current.lsp_commands.clone();
            lsp_commands.retain(|language, _| !languages.contains(language));
            UserConfigPatch { lsp_commands: Some(lsp_commands), ..Default::default() }
        }
    };
    let printed = Printed::of(&patch);
    let config = store.set(patch).await?;
    printed.print(&config);
    Ok(())
}

/// What a change prints afterwards: the setting it changed, as stored.
enum Printed {
    AutoViewed,
    Context,
    FollowRefs,
    Lsp,
}

impl Printed {
    fn of(patch: &UserConfigPatch) -> Self {
        if patch.auto_viewed.is_some() {
            Self::AutoViewed
        } else if patch.context_lines.is_some() {
            Self::Context
        } else if patch.follow_refs.is_some() {
            Self::FollowRefs
        } else {
            Self::Lsp
        }
    }

    fn print(&self, config: &UserConfig) {
        match self {
            Self::AutoViewed => println!("{}", config.auto_viewed.join("\n")),
            Self::Context => println!("{}", config.context_lines),
            Self::FollowRefs => println!("{}", config.follow_refs),
            Self::Lsp => {
                // Sorted by language: the stored map keeps no order of its own.
                let mut commands: Vec<_> = config.lsp_commands.iter().collect();
                commands.sort_by_key(|(language, _)| language.to_string());
                for (language, command) in commands {
                    println!("{language}={command}");
                }
            }
        }
    }
}

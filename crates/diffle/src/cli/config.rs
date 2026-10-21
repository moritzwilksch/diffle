//! `diffle config`: where the settings live, and what they are.
use crate::user_config::UserConfigStore;

pub async fn run() -> anyhow::Result<()> {
    let store = UserConfigStore::open(UserConfigStore::default_path()).await;
    // The path is for the reader; stdout carries the config alone, so `diffle config | jq` works.
    crate::status!("{}", store.file().display());
    println!("{}", serde_json::to_string_pretty(&store.get())?);
    Ok(())
}

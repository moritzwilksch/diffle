//! Review comments: persistence, relocation, import, and prompt formatting.
pub mod activity;
pub mod anchor;
mod context;
pub mod format;
mod handoff;
pub mod hunks;
pub mod import;
mod relocation;
mod store;
mod tour;

pub use handoff::format_followup;
pub use import::AnchorSource;
pub use relocation::{ReviewView, SideView};
pub use store::CommentStore;

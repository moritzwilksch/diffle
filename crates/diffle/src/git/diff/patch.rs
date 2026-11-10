//! Patches for changed files, each side read as the snapshot recorded it.
use gix::ObjectId;
use gix::bstr::{BString, ByteSlice};
use gix::prelude::ObjectIdExt;

use super::sides::{self, Item, Reader};
use super::unified::{self, Body, Side};
use super::{is_binary, rename, tree_id};
use crate::error::Result;
use crate::git::{GitRepo, WORKTREE};
use crate::protocol::{ChangeStatus, ChangedFile};

impl GitRepo {
    /// One file's patch.
    pub async fn patch(&self, old: &str, new: &str, file: &ChangedFile, context: u32) -> Result<String> {
        self.patches(old, new, std::slice::from_ref(file), context, false).await
    }

    /// Every changed file's patch, concatenated in order; an untracked binary file has none.
    pub async fn patch_all(&self, old: &str, new: &str, files: &[ChangedFile], context: u32) -> Result<String> {
        self.patches(old, new, files, context, true).await
    }

    /// Patches for `files` only, concatenated in order.
    pub async fn patch_many(&self, old: &str, new: &str, files: &[ChangedFile], context: u32) -> Result<String> {
        self.patches(old, new, files, context, false).await
    }

    async fn patches(
        &self,
        old: &str,
        new: &str,
        files: &[ChangedFile],
        context: u32,
        skip_untracked_binary: bool,
    ) -> Result<String> {
        if (old == WORKTREE && new == WORKTREE) || files.is_empty() {
            return Ok(String::new());
        }
        let (old, new, files, root) = (old.to_owned(), new.to_owned(), files.to_vec(), self.root.clone());
        self.gix("writing patches", move |repo| {
            let index = repo.index_or_empty()?;
            let lookup = |rev: &str| -> anyhow::Result<Option<gix::Tree<'_>>> {
                if rev == WORKTREE { Ok(None) } else { Ok(Some(repo.find_tree(tree_id(repo, rev)?)?)) }
            };
            let (old_tree, new_tree) = (lookup(&old)?, lookup(&new)?);
            let caps = repo.filesystem_options()?;
            // The status says which sides exist; an empty blob on one that does is a worktree file
            // that could not be read, the null id here, which reads as binary.
            let side = |tree: &Option<gix::Tree<'_>>,
                        path: &str,
                        id: &str,
                        present: bool|
             -> anyhow::Result<Option<Item>> {
                if !present {
                    return Ok(None);
                }
                let id =
                    if id.is_empty() { ObjectId::null(repo.object_hash()) } else { ObjectId::from_hex(id.as_bytes())? };
                Ok(Some(match tree {
                    Some(tree) => {
                        let mode =
                            tree.lookup_entry_by_path(path)?.map_or(sides::FILE, |e| u32::from(e.mode().value()));
                        Item { path: path.into(), mode, id, worktree: false, untracked: false }
                    }
                    None => super::worktree::worktree_item(&root, path, id, &index, caps),
                }))
            };
            let mut reader = Reader::new(repo, &root)?;
            let mut out = Vec::new();
            for file in &files {
                let old_path = file.old_path.as_deref().unwrap_or(&file.path);
                let a = side(&old_tree, old_path, &file.old_blob, file.status != ChangeStatus::A)?;
                let b = side(&new_tree, &file.path, &file.blob, file.status != ChangeStatus::D)?;
                let worktree_only = a.as_ref().is_none_or(|a| a.worktree) && b.as_ref().is_none_or(|b| b.worktree);
                let path = BString::from(file.path.as_str());
                if skip_untracked_binary
                    && file.binary
                    && worktree_only
                    && index.entry_by_path(path.as_bstr()).is_none()
                {
                    continue;
                }
                write_patch(&mut out, repo, &mut reader, a, b, file, context);
            }
            Ok(String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
        })
        .await
    }
}

fn write_patch(
    out: &mut Vec<u8>,
    repo: &gix::Repository,
    reader: &mut Reader<'_>,
    old: Option<Item>,
    new: Option<Item>,
    file: &ChangedFile,
    context: u32,
) {
    let read = |reader: &mut Reader<'_>, item: Option<&Item>| match item {
        Some(item) if !file.binary => reader.content(item),
        Some(_) => None,
        None => Some(Vec::new()),
    };
    let (before, after) = (read(reader, old.as_ref()), read(reader, new.as_ref()));
    let rename = file.old_path.as_ref().map(|_| match (&old, &new) {
        (Some(o), Some(n)) if o.id == n.id => rename::MAX_SCORE,
        // A binary pair's contents go unread for the body, but its score is git's from them all the same.
        (Some(o), Some(n)) if file.binary => score(&reader.content(o), &reader.content(n)),
        _ => score(&before, &after),
    });
    write_pair(out, repo, (old.as_ref(), new.as_ref()), rename, (&before, &after), context);
}

/// The rename score of two contents, as `detect_renames` paired them; 0 where one cannot be read.
fn score(before: &Option<Vec<u8>>, after: &Option<Vec<u8>>) -> u64 {
    let (Some(before), Some(after)) = (before, after) else { return 0 };
    let print = |content: &Vec<u8>| rename::Fingerprint::new(content, !is_binary(content));
    rename::score(&print(before), &print(after))
}

fn side<'a>(repo: &gix::Repository, item: &'a Item, abbrev: usize) -> Side<'a> {
    Side { path: &item.path, mode: item.mode, id: item.id, short: short(repo, item.id, abbrev) }
}

/// Appends one pair's patch from its contents, none where binary.
pub(super) fn write_pair(
    out: &mut Vec<u8>,
    repo: &gix::Repository,
    (old, new): (Option<&Item>, Option<&Item>),
    rename: Option<u64>,
    (before, after): (&Option<Vec<u8>>, &Option<Vec<u8>>),
    context: u32,
) {
    let abbrev = abbrev(repo);
    let side = |item| side(repo, item, abbrev);
    let (old_side, new_side) = (old.map(side), new.map(side));
    let (empty_before, empty_after) = (Some(Vec::new()), Some(Vec::new()));
    match (&old_side, &new_side) {
        (Some(o), Some(n)) if unified::splits(o.mode, n.mode) => {
            unified::write(out, (Some(o), None), None, body(before, &empty_after), context, abbrev);
            unified::write(out, (None, Some(n)), None, body(&empty_before, after), context, abbrev);
        }
        _ => {
            let sides = (old_side.as_ref(), new_side.as_ref());
            unified::write(out, sides, rename, body(before, after), context, abbrev);
        }
    }
}

/// Text to diff when both sides read as text, else binary.
fn body<'a>(before: &'a Option<Vec<u8>>, after: &'a Option<Vec<u8>>) -> Body<'a> {
    match (before, after) {
        (Some(b), Some(a)) if !is_binary(b) && !is_binary(a) => Body::Text(b, a),
        _ => Body::Binary,
    }
}

/// The abbreviated id git prints in an `index` line: unique among the repository's objects, and
/// at least `abbrev` long, which an object git does not store yet gets exactly.
fn short(repo: &gix::Repository, id: ObjectId, abbrev: usize) -> String {
    id.attach(repo).shorten().map_or_else(|_| id.to_hex_with_len(abbrev).to_string(), |p| p.to_string())
}

/// Git's shortest abbreviation: `core.abbrev`, or by default one growing with the packed object count.
fn abbrev(repo: &gix::Repository) -> usize {
    let full = repo.object_hash().len_in_hex();
    match repo.config_snapshot().string("core.abbrev").map(|v| v.to_string()) {
        Some(v) if v.parse::<usize>().is_ok() => v.parse::<usize>().unwrap_or(7).clamp(4, full),
        Some(v) if ["no", "false", "off"].contains(&v.to_lowercase().as_str()) => full,
        _ => {
            let objects = repo.objects.packed_object_count().unwrap_or(0);
            ((64 - objects.leading_zeros()).div_ceil(2) as usize).max(7)
        }
    }
}

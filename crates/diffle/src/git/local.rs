//! Fetching from a repository on disk without a `git-upload-pack` to talk to: the objects the
//! target lacks go over as one pack, as `git fetch` sends them, and a clone links the source's
//! object store, as `git clone` does for a local path.
use std::collections::HashSet;
use std::io::{BufReader, Seek};
use std::path::Path;
use std::sync::atomic::AtomicBool;

use anyhow::Context;
use gix::ObjectId;
use gix::odb::pack::data::output::{self, count::objects::ObjectExpansion};
use gix::parallel::InOrderIter;

use super::refs;

/// Fetches `refspecs` (`+src:dst`, or `+prefix/*:prefix/*`) from the repository at `path`: the
/// objects the refs need, then the refs. Returns the full name of the branch its HEAD names.
pub(super) fn copy_refs(repo: &gix::Repository, path: &Path, refspecs: &[String]) -> anyhow::Result<Option<String>> {
    let source = gix::open(path).with_context(|| format!("{} is not a repository", path.display()))?;
    let mut wanted: Vec<(String, ObjectId)> = Vec::new();
    for spec in refspecs {
        let spec = spec.trim_start_matches('+');
        let (src, dst) = spec.split_once(':').unwrap_or((spec, spec));
        match (src.strip_suffix('*'), dst.strip_suffix('*')) {
            (Some(src), Some(dst)) => {
                let names: Vec<String> = source
                    .references()?
                    .prefixed(src)?
                    .filter_map(Result::ok)
                    .map(|r| r.name().as_bstr().to_string())
                    .collect();
                for name in names {
                    let id = source.find_reference(name.as_str())?.peel_to_id()?.detach();
                    wanted.push((format!("{dst}{}", &name[src.len()..]), id));
                }
            }
            _ => {
                let mut found =
                    source.find_reference(src).with_context(|| format!("couldn't find remote ref {src}"))?;
                wanted.push((dst.to_owned(), found.peel_to_id()?.detach()));
            }
        }
    }
    let tips: Vec<ObjectId> = wanted.iter().map(|(_, id)| *id).collect();
    let keep = transfer(&source, repo, &tips)?;
    let edits = wanted.iter().map(|(dst, id)| refs::update(dst, *id)).collect::<anyhow::Result<Vec<_>>>()?;
    if !edits.is_empty() {
        repo.edit_references(edits)?;
    }
    // The pack was kept from `gc` only until a ref reached it.
    if let Some(keep) = keep {
        std::fs::remove_file(keep)?;
    }
    Ok(source.head_name()?.map(|name| name.as_bstr().to_string()))
}

/// Writes one pack of what `target` lacks to reach `tips`: the commits it has not, with the
/// trees and blobs each adds to its parents; the tags on the way; and a tree or blob a tag names,
/// with all it holds. Entries the source has packed are copied as they are. Returns the pack's
/// `.keep` file.
fn transfer(
    source: &gix::Repository,
    target: &gix::Repository,
    tips: &[ObjectId],
) -> anyhow::Result<Option<std::path::PathBuf>> {
    let (mut commits, mut tags, mut others) = (Vec::new(), Vec::new(), Vec::new());
    let (mut pending, mut seen) = (tips.to_vec(), HashSet::new());
    while let Some(id) = pending.pop() {
        if !seen.insert(id) || target.has_object(id) {
            continue;
        }
        let object = source.find_header(id)?;
        match object.kind() {
            gix::objs::Kind::Commit => {
                pending.extend(source.find_commit(id)?.parent_ids().map(gix::Id::detach));
                commits.push(id);
            }
            gix::objs::Kind::Tag => {
                pending.push(source.find_tag(id)?.target_id()?.detach());
                tags.push(id);
            }
            _ => others.push(id),
        }
    }
    if commits.is_empty() && tags.is_empty() && others.is_empty() {
        return Ok(None);
    }
    let mut db = source.objects.clone().into_arc()?.into_inner();
    // Counts remember pack locations, so packs must stay mapped; objects go as stored, as
    // `upload-pack` sends them, never their `git replace` stand-ins.
    db.prevent_pack_unload();
    db.ignore_replacements = true;
    let interrupt = AtomicBool::new(false);
    let count = |ids: Vec<ObjectId>, input_object_expansion| {
        let options = output::count::objects::Options { input_object_expansion, ..Default::default() };
        let ids = Box::new(ids.into_iter().map(Ok));
        output::count::objects(db.clone(), ids, &gix::progress::Discard, &interrupt, options).map(|(counts, _)| counts)
    };
    let mut counts = count(commits, ObjectExpansion::TreeAdditionsComparedToAncestor)?;
    counts.extend(count(tags, ObjectExpansion::AsIs)?);
    counts.extend(count(others, ObjectExpansion::TreeContents)?);
    let mut unique = HashSet::new();
    counts.retain(|c| unique.insert(c.id));
    let entries = output::entry::iter_from_counts(counts, db, Box::new(gix::progress::Discard), Default::default())?;
    let pack_dir = target.objects.store_ref().path().join("pack");
    let mut pack = tempfile::tempfile_in(&pack_dir)?;
    let mut written = output::bytes::FromEntriesIter::new(
        InOrderIter::from(entries),
        &mut pack,
        u32::try_from(unique.len())?,
        gix::odb::pack::data::Version::V2,
        target.object_hash(),
    );
    for chunk in written.by_ref() {
        chunk?;
    }
    drop(written);
    pack.rewind()?;
    let outcome = gix::odb::pack::Bundle::write_to_directory(
        &mut BufReader::new(pack),
        Some(&pack_dir),
        &mut gix::progress::Discard,
        &interrupt,
        None::<gix::objs::find::Never>,
        target.object_hash(),
        Default::default(),
    )?;
    Ok(outcome.keep_path)
}

/// Links `source`'s objects into the empty `target`, or copies them where links cannot be made:
/// packs and loose objects never change once written. Its alternates carry over, made absolute.
pub(super) fn link_objects(source: &gix::Repository, target: &gix::Repository) -> anyhow::Result<()> {
    let (from, to) = (source.objects.store_ref().path(), target.objects.store_ref().path());
    link_dir(from, to, from)?;
    let alternates = from.join("info").join("alternates");
    if let Ok(list) = std::fs::read_to_string(&alternates) {
        let absolute: String = list
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
            .map(|line| format!("{}\n", from.join(line).display()))
            .collect();
        std::fs::write(to.join("info").join("alternates"), absolute)?;
    }
    Ok(())
}

fn link_dir(dir: &Path, to: &Path, root: &Path) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        // Another writer's files in flight, and the alternates, which `link_objects` rewrites.
        if name.to_string_lossy().starts_with("tmp") || path == root.join("info").join("alternates") {
            continue;
        }
        let dest = to.join(path.strip_prefix(root)?);
        if entry.file_type()?.is_dir() {
            std::fs::create_dir_all(&dest)?;
            link_dir(&path, to, root)?;
        } else if !dest.exists() && std::fs::hard_link(&path, &dest).is_err() {
            std::fs::copy(&path, &dest)?;
        }
    }
    Ok(())
}

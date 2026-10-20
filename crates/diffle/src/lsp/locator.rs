//! Mapping a server's URIs back to snapshot paths, and remembering the outside files it named.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use futures::future::BoxFuture;
use indexmap::IndexSet;
use regex::Regex;

use super::documents::ReadFn;
use super::hover::file_link_uris;
use super::shapes::Range;
use crate::concurrency::map_limit;
use crate::protocol::LspLocation;

/// Whether the snapshot exposes a path on its new side. Membership only: no content is read.
pub type HasFn = Arc<dyn Fn(String) -> BoxFuture<'static, bool> + Send + Sync>;

/// Concurrent snapshot reads while mapping a result set back to paths.
const READ_CONCURRENCY: usize = 8;
/// Files outside the snapshot remembered for `read_external`; the least recently named goes first.
const MAX_EXTERNAL: usize = 1024;

static LINE_FRAGMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^L?(\d+)").unwrap());

/// Maps the URIs a language server answers with back to snapshot paths, and remembers the files
/// outside the snapshot it named, so `/api/file` may serve those and nothing else beyond the
/// allowlist.
pub struct Locator {
    root: PathBuf,
    /// Symlink-free root; servers often canonicalize, so URIs may not share the root's spelling.
    real_root: PathBuf,
    read: ReadFn,
    has: HasFn,
    /// Absolute paths of files outside the snapshot that results named, least recently first.
    external: Mutex<IndexSet<PathBuf>>,
}

/// One located file: a snapshot path with its text, or an outside file read from disk.
struct Found {
    path: String,
    text: String,
    external: bool,
}

impl Locator {
    pub fn new(root: PathBuf, read: ReadFn, has: HasFn) -> Self {
        let real_root = dunce::canonicalize(&root).unwrap_or_else(|_| root.clone());
        Self { root, real_root, read, has, external: Mutex::default() }
    }

    /// Repo-relative path for a file URI inside the root; none otherwise. Compares lexically first,
    /// then by realpath, so a canonicalized URI still matches a root reached through a symlink.
    pub async fn path_of(&self, uri: &str) -> Option<String> {
        let abs = file_path(uri)?;
        if let Some(rel) = relative_inside(&self.root, &abs) {
            return Some(rel);
        }
        let real = tokio::task::spawn_blocking(move || dunce::canonicalize(abs).ok()).await.ok().flatten()?;
        relative_inside(&self.real_root, &real)
    }

    /// Server locations as paths with the text of each line: a snapshot path, or, for a file the
    /// snapshot lacks (stdlib, site-packages, an ignored venv), the file itself read from disk and
    /// marked external. Each distinct URI is read once; a file readable neither way is dropped.
    pub async fn locations(
        &self,
        locs: &[(String, Range)],
        text_of: &(dyn Fn(&str) -> Option<String> + Sync),
    ) -> Vec<LspLocation> {
        let mut uris: Vec<String> = Vec::new();
        for (uri, _) in locs {
            if !uris.contains(uri) {
                uris.push(uri.clone());
            }
        }
        let found =
            map_limit(uris.clone(), READ_CONCURRENCY, |uri| async move { self.locate(&uri, text_of).await }).await;
        let by_uri: HashMap<String, Option<Found>> = uris.into_iter().zip(found).collect();
        locs.iter()
            .filter_map(|(uri, range)| {
                let f = by_uri.get(uri)?.as_ref()?;
                let line = range.start.line + 1;
                Some(LspLocation {
                    path: f.path.clone().try_into().ok()?,
                    line: std::num::NonZeroU64::new(u64::try_from(line).ok()?)?,
                    col: range.start.character,
                    text: line_at(&f.text, line),
                    external: f.external.then_some(true),
                })
            })
            .collect()
    }

    /// Where each `file:` link in hover text points inside the repository: the path and, from the
    /// URI's `#line` or `#line,col` fragment, the line. Links outside the root are left out.
    pub async fn links(&self, md: &str) -> HashMap<String, (String, Option<i64>)> {
        let mut out = HashMap::new();
        for uri in file_link_uris(md) {
            let (file, fragment) = uri.split_once('#').map_or((uri.as_str(), None), |(f, h)| (f, Some(h)));
            let Some(path) = self.path_of(file).await else { continue };
            // Both fragment shapes servers write: `#12` / `#12,7` (pyright) and `#L12`.
            let line = fragment.and_then(|h| LINE_FRAGMENT.captures(h)).and_then(|m| m[1].parse().ok());
            out.insert(uri, (path, line));
        }
        out
    }

    /// `has` for each distinct path.
    pub async fn membership(&self, paths: &[Option<String>]) -> HashMap<String, bool> {
        let distinct: Vec<String> = paths.iter().flatten().cloned().collect::<HashSet<_>>().into_iter().collect();
        let flags = map_limit(distinct.clone(), READ_CONCURRENCY, |p| (self.has)(p)).await;
        distinct.into_iter().zip(flags).collect()
    }

    /// Contents of a file outside the snapshot that a recent result named; none for every other
    /// path. The only read done on a client's behalf beyond the snapshot allowlist.
    pub async fn read_external(&self, path: &str) -> Option<Vec<u8>> {
        let path = PathBuf::from(path);
        if !self.external.lock().unwrap().contains(&path) {
            return None;
        }
        tokio::fs::read(&path).await.ok()
    }

    async fn locate(&self, uri: &str, text_of: &(dyn Fn(&str) -> Option<String> + Sync)) -> Option<Found> {
        if let Some(path) = self.path_of(uri).await {
            let text = match text_of(&path) {
                Some(text) => Some(text),
                None => (self.read)(path.clone()).await,
            };
            if let Some(text) = text {
                return Some(Found { path, text, external: false });
            }
        }
        let abs = file_path(uri)?;
        let text = tokio::fs::read_to_string(&abs).await.ok()?;
        self.remember(abs.clone());
        Some(Found { path: abs.to_string_lossy().into_owned(), text, external: true })
    }

    fn remember(&self, abs: PathBuf) {
        let mut external = self.external.lock().unwrap();
        // Re-inserted at the end: the most recently named.
        external.shift_remove(&abs);
        external.insert(abs);
        while external.len() > MAX_EXTERNAL {
            external.shift_remove_index(0);
        }
    }
}

fn file_path(uri: &str) -> Option<PathBuf> {
    url::Url::parse(uri).ok().filter(|u| u.scheme() == "file")?.to_file_path().ok()
}

/// `abs` relative to `root` with forward slashes when it lies inside it; none otherwise.
fn relative_inside(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    if rel.as_os_str().is_empty() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    Some(rel.to_string_lossy().replace('\\', "/"))
}

fn line_at(text: &str, line: i64) -> String {
    let found = text.split('\n').nth((line - 1).max(0) as usize).unwrap_or_default();
    found.strip_suffix('\r').unwrap_or(found).to_owned()
}

//! What changed between two sides, and what git would store for the worktree's side.
use std::collections::{HashMap, HashSet};

use sha1::{Digest, Sha1};

use super::exec::{ExecOptions, exec_git, split_z};
use super::{BIG_FILE_THRESHOLD, GitRepo, READ_CONCURRENCY, WORKTREE, diff_range};
use crate::concurrency::map_limit;
use crate::error::{GitError, Result};
use crate::protocol::{ChangeStatus, ChangedFile};

impl GitRepo {
    pub async fn ls_files(&self) -> Result<Vec<String>, GitError> {
        Ok(split_z(&self.exec(&["ls-files", "-z"], ExecOptions::default()).await?))
    }

    /// Every path in a commit's tree.
    pub async fn ls_tree(&self, rev: &str) -> Result<Vec<String>, GitError> {
        Ok(split_z(&self.exec(&["ls-tree", "-r", "-z", "--name-only", rev], ExecOptions::default()).await?))
    }

    pub async fn untracked(&self) -> Result<Vec<String>, GitError> {
        Ok(split_z(&self.exec(&["ls-files", "-z", "--others", "--exclude-standard"], ExecOptions::default()).await?))
    }

    /// Ignored files and directories (directories end with '/'). Feeds the watcher.
    pub async fn ignored_paths(&self) -> Result<Vec<String>, GitError> {
        let args = ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"];
        Ok(split_z(&self.exec(&args, ExecOptions::default()).await?))
    }

    /// Paths git ignores, from a candidate list.
    pub async fn ignored(&self, paths: &[String]) -> Result<HashSet<String>, GitError> {
        if paths.is_empty() {
            return Ok(HashSet::new());
        }
        let input = paths.join("\0");
        let opts = ExecOptions { input: Some(input.as_bytes()), ok_codes: &[0, 1], ..Default::default() };
        Ok(split_z(&self.exec(&["check-ignore", "-z", "--stdin"], opts).await?).into_iter().collect())
    }

    /// Boolean value of a gitattribute per path: `attr` or `attr=true` reads true, `-attr` or
    /// `attr=false` false; unspecified paths are absent. A revision reads `.gitattributes` from
    /// that tree, the worktree from the checkout. `--source` needs git 2.40.
    pub async fn attr(&self, name: &str, paths: &[String], rev: &str) -> Result<HashMap<String, bool>, GitError> {
        let mut out = HashMap::new();
        if paths.is_empty() {
            return Ok(out);
        }
        let source = format!("--source={rev}");
        let mut args = vec!["check-attr", "-z", "--stdin"];
        if rev != WORKTREE {
            args.push(&source);
        }
        args.extend([name, "--"]);
        let input = paths.join("\0");
        let fields =
            split_z(&self.exec(&args, ExecOptions { input: Some(input.as_bytes()), ..Default::default() }).await?);
        // Records are `path NUL attr NUL value NUL`.
        for record in fields.as_chunks::<3>().0 {
            match record[2].as_str() {
                "set" | "true" => out.insert(record[0].clone(), true),
                "unset" | "false" => out.insert(record[0].clone(), false),
                _ => None,
            };
        }
        Ok(out)
    }

    /// Changed files between two revs, or a rev and the worktree (untracked files included). One
    /// diff call yields status, line counts and, against a commit, each side's blob; the
    /// worktree's blobs are hashed from disk.
    pub async fn numstat(&self, old: &str, new: &str) -> Result<Vec<ChangedFile>> {
        if old == WORKTREE && new == WORKTREE {
            return Ok(Vec::new());
        }
        let reverse = old == WORKTREE;
        let mut args = vec!["diff", "-z", "-M", "--raw", "--no-abbrev", "--numstat"];
        args.extend(diff_range(old, new));
        let live = old == WORKTREE || new == WORKTREE;
        let (diff, untracked) = tokio::join!(self.exec(&args, ExecOptions::default()), async {
            if live { self.untracked().await } else { Ok(Vec::new()) }
        });
        let mut files = parse_raw_numstat(&diff?);
        let known: HashSet<&str> =
            files.iter().flat_map(|f| [Some(f.path.as_str()), f.old_path.as_deref()]).flatten().collect();
        // `ls-files --others` lists a nested repository as `dir/`; git has no diff for it.
        let extra: Vec<String> =
            untracked?.into_iter().filter(|p| !known.contains(p.as_str()) && !p.ends_with('/')).collect();
        let extra = map_limit(extra, READ_CONCURRENCY, |path| self.untracked_file(path, reverse)).await;
        files.extend(extra);
        files.sort_by(|a, b| a.path.cmp(&b.path));
        if new == WORKTREE {
            let present: Vec<usize> = (0..files.len()).filter(|&i| files[i].status != ChangeStatus::D).collect();
            let entries: Vec<(String, bool)> =
                present.iter().map(|&i| (files[i].path.clone(), is_submodule(&files[i]))).collect();
            for (i, sha) in present.into_iter().zip(self.hash_worktree(&entries).await) {
                files[i].blob = sha;
            }
        }
        if reverse {
            let present: Vec<usize> = (0..files.len()).filter(|&i| files[i].status != ChangeStatus::A).collect();
            let entries: Vec<(String, bool)> = present
                .iter()
                .map(|&i| (files[i].old_path.clone().unwrap_or_else(|| files[i].path.clone()), is_submodule(&files[i])))
                .collect();
            for (i, sha) in present.into_iter().zip(self.hash_worktree(&entries).await) {
                files[i].old_blob = sha;
            }
        }
        Ok(files)
    }

    async fn untracked_file(&self, path: String, reverse: bool) -> ChangedFile {
        let mut file = blank(path, if reverse { ChangeStatus::D } else { ChangeStatus::A });
        let abs = self.root.join(&file.path);
        let meta = tokio::fs::symlink_metadata(&abs).await.ok();
        if meta.as_ref().is_some_and(|m| m.is_file() && m.len() >= BIG_FILE_THRESHOLD) {
            file.binary = true;
            return file;
        }
        // Unreadable (permissions) counts as empty: one bad path must not fail the snapshot.
        let buf = self.read_worktree(&file.path).await.ok().flatten().unwrap_or_default();
        file.binary = is_binary(&buf);
        if !file.binary {
            let lines = count_lines(&buf);
            if reverse { file.deletions = lines } else { file.additions = lines }
        }
        file
    }

    /// What git would store for each worktree entry, in order: the file's blob, a symlink's target
    /// blob, a submodule's checked-out commit. Regular files go to one `hash-object --stdin-paths`
    /// call; everything else is hashed on its own, so a gitlink, a broken link or an unreadable
    /// path never fails the batch. A path that cannot be hashed gets an empty blob.
    async fn hash_worktree(&self, files: &[(String, bool)]) -> Vec<String> {
        let kinds = map_limit(0..files.len(), READ_CONCURRENCY, |i| async move {
            let (path, submodule) = &files[i];
            if *submodule {
                return Hashed::Done(self.submodule_head(path).await);
            }
            let abs = self.root.join(path);
            match tokio::fs::symlink_metadata(&abs).await {
                Ok(m) if m.is_symlink() => match tokio::fs::read_link(&abs).await {
                    Ok(target) => Hashed::Done(blob_sha(target.to_string_lossy().as_bytes())),
                    Err(_) => Hashed::Done(String::new()),
                },
                Ok(m) if m.is_file() => Hashed::Regular,
                _ => Hashed::Done(String::new()),
            }
        })
        .await;
        let mut shas: Vec<String> = Vec::with_capacity(files.len());
        let mut regular = Vec::new();
        for (i, kind) in kinds.into_iter().enumerate() {
            shas.push(match kind {
                Hashed::Done(sha) => sha,
                Hashed::Regular => {
                    regular.push(i);
                    String::new()
                }
            });
        }
        // A path containing a newline cannot ride the stdin list.
        let (mut single, batch): (Vec<usize>, Vec<usize>) =
            regular.into_iter().partition(|&i| files[i].0.contains('\n'));
        if !batch.is_empty() {
            let input: String = batch.iter().map(|&i| format!("{}\n", files[i].0)).collect();
            let opts = ExecOptions { input: Some(input.as_bytes()), ..Default::default() };
            match self.text_with(&["hash-object", "--stdin-paths"], opts).await {
                Ok(out) => {
                    for (i, line) in batch.iter().zip(out.trim().lines()) {
                        shas[*i] = line.to_owned();
                    }
                }
                // One unreadable path (permissions, vanished mid-refresh) aborts git's whole batch; retry each alone.
                Err(_) => single.extend(batch),
            }
        }
        let hashed = map_limit(single.clone(), READ_CONCURRENCY, |i| async move {
            self.text(&["hash-object", "--", &files[i].0]).await.map(|s| s.trim().to_owned()).unwrap_or_default()
        })
        .await;
        for (i, sha) in single.into_iter().zip(hashed) {
            shas[i] = sha;
        }
        shas
    }

    /// What git would store for `content` at worktree `path`, its clean filters applied: equals the
    /// snapshot's blob for a worktree file whose bytes are still the snapshot's.
    pub async fn hash_object(&self, content: &[u8], path: &str) -> Result<String, GitError> {
        let path = format!("--path={path}");
        let opts = ExecOptions { input: Some(content), ..Default::default() };
        Ok(self.text_with(&["hash-object", "--stdin", &path], opts).await?.trim().to_owned())
    }

    /// The commit a checked-out submodule is at, or '' if it is not a repository.
    async fn submodule_head(&self, path: &str) -> String {
        exec_git(&self.root.join(path), &["rev-parse", "--verify", "--quiet", "HEAD"], ExecOptions::default())
            .await
            .map(|out| String::from_utf8_lossy(&out).trim().to_owned())
            .unwrap_or_default()
    }
}

enum Hashed {
    Done(String),
    Regular,
}

fn is_submodule(file: &ChangedFile) -> bool {
    file.submodule == Some(true)
}

fn blank(path: String, status: ChangeStatus) -> ChangedFile {
    ChangedFile {
        path,
        old_path: None,
        status,
        additions: 0,
        deletions: 0,
        binary: false,
        blob: String::new(),
        old_blob: String::new(),
        generated: false,
        submodule: None,
    }
}

/// `-z -M --raw --no-abbrev --numstat`: the raw records come first, then the numstat records, each
/// path-terminated by NUL. Raw: ":mode mode sha sha X\0path\0", renames and copies
/// "R100\0old\0new\0". Numstat: "add\tdel\tpath\0", renames "add\tdel\t\0old\0new\0". Binary files
/// count as "-\t-". The shas are each side's blob against a commit; against the worktree, or where
/// a side is absent, zeros. Mode 160000 on either side marks a gitlink.
fn parse_raw_numstat(buf: &[u8]) -> Vec<ChangedFile> {
    let parts = split_z(buf);
    let mut files: Vec<ChangedFile> = Vec::new();
    let mut by_path: HashMap<String, usize> = HashMap::new();
    let mut i = 0;
    let blob = |sha: &str| {
        if sha.bytes().all(|b| b == b'0') { String::new() } else { sha.to_owned() }
    };
    while i < parts.len() && parts[i].starts_with(':') {
        let fields: Vec<&str> = parts[i].split(' ').collect();
        let [src_mode, dst_mode, src_sha, dst_sha, code] = fields[..] else {
            break;
        };
        let status = match code.chars().next() {
            Some('A') => ChangeStatus::A,
            Some('D') => ChangeStatus::D,
            Some('R') => ChangeStatus::R,
            Some('C') => ChangeStatus::C,
            Some('T') => ChangeStatus::T,
            Some('U') => ChangeStatus::U,
            _ => ChangeStatus::M,
        };
        let old_path = matches!(status, ChangeStatus::R | ChangeStatus::C).then(|| {
            i += 1;
            parts[i].clone()
        });
        i += 1;
        let mut file = blank(parts[i].clone(), status);
        file.old_path = old_path;
        file.blob = blob(dst_sha);
        file.old_blob = blob(src_sha);
        if dst_mode == "160000" || (status == ChangeStatus::D && src_mode.get(1..) == Some("160000")) {
            file.submodule = Some(true);
        }
        by_path.insert(file.path.clone(), files.len());
        files.push(file);
        i += 1;
    }
    while i < parts.len() {
        let mut fields = parts[i].splitn(3, '\t');
        let (add, del) = (fields.next().unwrap_or_default(), fields.next().unwrap_or_default());
        let path = match fields.next() {
            Some(inline) if !inline.is_empty() => inline.to_owned(),
            _ => {
                i += 2;
                parts.get(i).cloned().unwrap_or_default()
            }
        };
        i += 1;
        let Some(&at) = by_path.get(&path) else { continue };
        let file = &mut files[at];
        file.binary = add == "-";
        if !file.binary {
            file.additions = add.parse().unwrap_or(0);
            file.deletions = del.parse().unwrap_or(0);
        }
    }
    files
}

/// The sha git gives a blob with these contents; what `hash-object --stdin` prints.
fn blob_sha(content: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", content.len()));
    hasher.update(content);
    hex::encode(hasher.finalize())
}

pub fn is_binary(buf: &[u8]) -> bool {
    buf[..buf.len().min(8000)].contains(&0)
}

fn count_lines(buf: &[u8]) -> i64 {
    if buf.is_empty() {
        return 0;
    }
    let newlines = buf.iter().filter(|&&b| b == b'\n').count() as i64;
    newlines + i64::from(buf.last() != Some(&b'\n'))
}

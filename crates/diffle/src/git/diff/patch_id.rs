//! `git patch-id --stable`, ported: a change's identity regardless of its message, whitespace and line numbers.
use gix::bstr::ByteSlice;
use sha1::{Digest, Sha1};

/// `git patch-id --stable` over one commit's patch: each file's header and hunk lines hashed
/// without whitespace or line numbers, the per-file hashes summed. None for an empty patch.
pub fn patch_id(patch: &[u8]) -> Option<String> {
    let mut result = [0u8; 20];
    let mut ctx = Sha1::new();
    let flush = |result: &mut [u8; 20], ctx: &mut Sha1| {
        let hash = std::mem::take(ctx).finalize();
        let mut carry = 0u16;
        for (r, h) in result.iter_mut().zip(hash) {
            carry += u16::from(*r) + u16::from(h);
            *r = carry as u8;
            carry >>= 8;
        }
    };
    let (mut patch_len, mut before, mut after) = (0usize, -1i64, -1i64);
    let (mut binary, mut pre, mut post) = (false, Vec::new(), Vec::new());
    for line in patch.split_inclusive(|&c| c == b'\n') {
        // A `\ No newline at end of file` marker is not part of the change.
        if line.starts_with(b"\\ ") && line.len() > 12 {
            continue;
        }
        if patch_len == 0 && !line.starts_with(b"diff ") {
            continue;
        }
        if before == -1 {
            if line.starts_with(b"GIT binary patch") || line.starts_with(b"Binary files") {
                (binary, before) = (true, 0);
                ctx.update(&pre);
                ctx.update(&post);
                flush(&mut result, &mut ctx);
                continue;
            } else if let Some(rest) = line.strip_prefix(b"index ") {
                if let Some(dots) = rest.find(b"..") {
                    let tail = &rest[dots + 2..];
                    let end = tail.find(b" ").unwrap_or(tail.len().saturating_sub(1));
                    (pre, post) = (rest[..dots].to_vec(), tail[..end].to_vec());
                }
                continue;
            } else if line.starts_with(b"--- ") {
                (before, after) = (1, 1);
            } else if !line.first().is_some_and(u8::is_ascii_alphabetic) {
                break;
            }
        }
        if binary {
            if line.starts_with(b"diff ") {
                (binary, before) = (false, -1);
            }
            continue;
        }
        if before == 0 && after == 0 {
            if line.starts_with(b"@@ -") {
                (before, after) = hunk_lengths(line);
                continue;
            }
            if !line.starts_with(b"diff ") {
                break;
            }
            flush(&mut result, &mut ctx);
            (before, after) = (-1, -1);
        }
        if matches!(line[0], b'-' | b' ') {
            before -= 1;
        }
        if matches!(line[0], b'+' | b' ') {
            after -= 1;
        }
        let kept: Vec<u8> =
            line.iter().copied().filter(|&c| !matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)).collect();
        patch_len += kept.len();
        ctx.update(&kept);
    }
    flush(&mut result, &mut ctx);
    (patch_len > 0).then(|| hex::encode(result))
}

/// The old and new line counts of an `@@ -a,b +c,d @@` header, a missing count being one.
fn hunk_lengths(line: &[u8]) -> (i64, i64) {
    let (old, rest) = hunk_count(&line[4..]);
    let rest = rest.strip_prefix(b" +").unwrap_or(rest);
    (old, hunk_count(rest).0)
}

/// One `start[,count]` field: the count, and what follows it.
fn hunk_count(s: &[u8]) -> (i64, &[u8]) {
    let digits = s.iter().take_while(|c| c.is_ascii_digit()).count();
    if s.get(digits) != Some(&b',') {
        return (1, &s[digits..]);
    }
    let rest = &s[digits + 1..];
    let n = rest.iter().take_while(|c| c.is_ascii_digit()).count();
    (std::str::from_utf8(&rest[..n]).ok().and_then(|n| n.parse().ok()).unwrap_or(0), &rest[n..])
}

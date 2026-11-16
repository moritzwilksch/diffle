//! How a language-server query's fate is decided from one status; the client decides the same way,
//! so its flash and the API's 409 say the same thing.
use super::{LanguageId, LspFeature, LspServerStatus, LspState, LspStatus, Snapshot, follows_checkout, language_of};

/// How messages name a feature: "pyrefly offers no go to definition".
pub fn feature_label(feature: LspFeature) -> &'static str {
    match feature {
        LspFeature::Definition => "go to definition",
        LspFeature::TypeDefinition => "go to type definition",
        LspFeature::Hover => "hover",
        LspFeature::References => "references",
        LspFeature::DocumentSymbol => "document symbols",
        LspFeature::WorkspaceSymbol => "workspace symbols",
        LspFeature::DocumentHighlight => "document highlights",
    }
}

#[derive(Default)]
pub struct LspQuery<'a> {
    /// The file asked about; without one, the request is repository-wide.
    pub path: Option<&'a str>,
    pub feature: Option<LspFeature>,
    /// Let a starting server through: the pool waits for it to initialize.
    pub patient: bool,
}

/// Whether the new side of `snap` is what the language servers read: false for a snapshot not loaded yet.
pub fn readable_by_servers(snap: Option<&Snapshot>) -> bool {
    snap.is_some_and(follows_checkout)
}

/// Why no language server can answer the query right now, or none when one can. `checkout` is
/// `readable_by_servers` of the current snapshot.
pub fn lsp_blocker(lsp: &LspStatus, checkout: bool, q: &LspQuery<'_>) -> Option<String> {
    if !lsp.enabled {
        return Some("Language servers are off for this run (--no-lsp)".into());
    }
    if !checkout {
        return Some("Symbol navigation needs the new side to be the worktree or the checked-out commit".into());
    }
    let mut servers: Vec<&LspServerStatus> = lsp.servers.iter().collect();
    let mut language = None;
    if let Some(path) = q.path {
        let Some(found) = language_of(path) else {
            let ext = path.rfind('.').map(|i| &path[i..]).filter(|e| !e[1..].contains(['/', '\\']) && e.len() > 1);
            return Some(format!("No language server for {} files", ext.unwrap_or("these")));
        };
        language = Some(found);
        servers = servers_for(lsp, found);
    }
    if servers.is_empty() {
        return Some(no_server(lsp, language));
    }
    // A starting server has not said what it offers yet, so it may still answer.
    let able: Vec<&LspServerStatus> = match q.feature {
        Some(f) => {
            servers.iter().copied().filter(|s| s.state == LspState::Starting || s.supports.contains(&f)).collect()
        }
        None => servers.clone(),
    };
    if able.is_empty() {
        let names: Vec<&str> = servers.iter().map(|s| s.name.as_str()).collect();
        return Some(format!("{} offers no {}", names.join(", "), feature_label(q.feature.expect("a feature"))));
    }
    let answers = able.iter().any(|s| s.state == LspState::Ready || (q.patient && s.state == LspState::Starting));
    (!answers).then(|| not_ready(able[0]))
}

/// The servers answering for `language`, its owners before the ones joining it.
pub fn servers_for(lsp: &LspStatus, language: LanguageId) -> Vec<&LspServerStatus> {
    let owners = lsp.servers.iter().filter(|s| s.languages.contains(&language));
    owners.chain(lsp.servers.iter().filter(|s| s.joins.contains(&language))).collect()
}

/// A server's languages for a status line: the ones it owns, then the ones it joins marked `+`.
pub fn languages_label(server: &LspServerStatus) -> String {
    let owned = server.languages.iter().map(|l| l.to_string());
    owned.chain(server.joins.iter().map(|l| format!("+{l}"))).collect::<Vec<_>>().join(", ")
}

fn not_ready(s: &LspServerStatus) -> String {
    if s.state == LspState::Starting {
        format!("{} is starting…", s.name)
    } else {
        format!("{} is unavailable: {}", s.name, s.message.as_deref().unwrap_or("unknown error"))
    }
}

/// No server serves `language` (or nothing runs at all): say what the reader can do about it.
fn no_server(lsp: &LspStatus, language: Option<LanguageId>) -> String {
    let missing: Vec<_> = lsp.missing.iter().filter(|m| language.is_none_or(|l| m.language == l)).collect();
    // A broken installation is the one thing installing something else will not fix.
    if let Some(broken) = missing.iter().find(|m| m.why.is_some()) {
        return format!("No language server for {}: {}", broken.language, broken.why.as_deref().unwrap_or_default());
    }
    let unique = |items: Vec<String>| {
        items.into_iter().fold(Vec::<String>::new(), |mut acc, s| {
            if !acc.contains(&s) {
                acc.push(s);
            }
            acc
        })
    };
    let absent: Vec<_> = missing.iter().filter(|m| !m.tried.is_empty()).collect();
    if !absent.is_empty() {
        let langs = unique(absent.iter().map(|m| m.language.to_string()).collect());
        let programs = unique(absent.iter().flat_map(|m| m.tried.clone()).collect());
        return format!("No language server for {} on PATH: install one of {}", langs.join(", "), programs.join(", "));
    }
    let off: Vec<String> = missing.iter().filter(|m| m.tried.is_empty()).map(|m| m.language.to_string()).collect();
    if !off.is_empty() {
        return format!("The language server for {} is off in your diffle config", off.join(", "));
    }
    match language {
        None => "No language server runs for this diff".into(),
        Some(l) => format!("No language server runs for {l}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::LspMissing;

    fn server(f: impl FnOnce(&mut LspServerStatus)) -> LspServerStatus {
        let mut s: LspServerStatus = serde_json::from_value(serde_json::json!({
            "name": "pyrefly", "command": "pyrefly lsp", "state": "ready", "languages": ["python"], "joins": [],
            "supports": ["definition", "typeDefinition", "hover", "references", "documentSymbol", "workspaceSymbol", "documentHighlight"],
            "log": { "seq": 0, "errors": 0, "warnings": 0 },
        }))
        .unwrap();
        f(&mut s);
        s
    }

    fn status(servers: Vec<LspServerStatus>) -> LspStatus {
        LspStatus { enabled: true, servers, missing: Vec::new() }
    }

    fn at(path: &str, feature: Option<LspFeature>) -> LspQuery<'_> {
        LspQuery { path: Some(path), feature, patient: false }
    }

    #[test]
    fn names_the_run_the_snapshot_the_language_the_server_and_the_feature_in_that_order() {
        let on = status(vec![server(|_| {})]);
        let off = LspStatus { enabled: false, servers: Vec::new(), missing: Vec::new() };
        assert!(lsp_blocker(&off, true, &LspQuery::default()).unwrap().contains("--no-lsp"));
        assert!(lsp_blocker(&on, false, &LspQuery::default()).unwrap().contains("new side"));
        assert_eq!(lsp_blocker(&on, true, &at("notes.txt", None)).unwrap(), "No language server for .txt files");
        assert_eq!(lsp_blocker(&on, true, &at("main.go", None)).unwrap(), "No language server runs for go");
        let mut broken = on.clone();
        broken.missing = vec![LspMissing {
            language: LanguageId::Vue,
            tried: vec!["vtsls".into()],
            why: Some("vue-language-server is on PATH but its plugin is not".into()),
        }];
        assert_eq!(
            lsp_blocker(&broken, true, &at("App.vue", None)).unwrap(),
            "No language server for vue: vue-language-server is on PATH but its plugin is not"
        );
        assert_eq!(lsp_blocker(&on, true, &at("a.py", Some(LspFeature::References))), None);
        let workspace = LspQuery { feature: Some(LspFeature::WorkspaceSymbol), ..Default::default() };
        assert_eq!(lsp_blocker(&on, true, &workspace), None);
        let hoverish = status(vec![server(|s| s.supports = vec![LspFeature::Hover])]);
        assert_eq!(
            lsp_blocker(&hoverish, true, &at("a.py", Some(LspFeature::Definition))).unwrap(),
            "pyrefly offers no go to definition"
        );
        assert_eq!(lsp_blocker(&hoverish, true, &at("a.py", Some(LspFeature::Hover))), None);
    }

    #[test]
    fn lets_a_starting_server_through_only_for_a_patient_caller_and_never_a_dead_one() {
        let starting = status(vec![server(|s| {
            s.state = LspState::Starting;
            s.supports.clear();
        })]);
        assert_eq!(
            lsp_blocker(&starting, true, &at("a.py", Some(LspFeature::Definition))).unwrap(),
            "pyrefly is starting…"
        );
        let patient = LspQuery { patient: true, ..at("a.py", Some(LspFeature::Definition)) };
        assert_eq!(lsp_blocker(&starting, true, &patient), None);
        let dead = status(vec![server(|s| {
            s.state = LspState::Unavailable;
            s.message = Some("exited (1)".into());
            s.supports.clear();
        })]);
        let patient = LspQuery { patient: true, ..at("a.py", None) };
        assert_eq!(lsp_blocker(&dead, true, &patient).unwrap(), "pyrefly is unavailable: exited (1)");
    }

    #[test]
    fn counts_a_server_joining_the_language_after_its_owner() {
        let tailwind = server(|s| {
            s.name = "tailwind".into();
            s.languages.clear();
            s.joins = vec![LanguageId::Css];
            s.supports = vec![LspFeature::Hover];
        });
        assert_eq!(lsp_blocker(&status(vec![tailwind.clone()]), true, &at("a.css", Some(LspFeature::Hover))), None);
        assert_eq!(
            lsp_blocker(&status(vec![tailwind.clone()]), true, &at("a.css", Some(LspFeature::Definition))).unwrap(),
            "tailwind offers no go to definition"
        );
        let starting = server(|s| {
            s.name = "css".into();
            s.state = LspState::Starting;
            s.languages = vec![LanguageId::Css];
            s.supports.clear();
        });
        assert_eq!(
            lsp_blocker(&status(vec![tailwind, starting]), true, &at("a.css", Some(LspFeature::Definition))).unwrap(),
            "css is starting…"
        );
    }
}

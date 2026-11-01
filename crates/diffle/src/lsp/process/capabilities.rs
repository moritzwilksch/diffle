//! What a server says it offers, its `initialize` capabilities and its (un)registrations since, and
//! the handlers answering what it sends diffle.
use std::sync::{Arc, Weak};

use futures::FutureExt;
use futures::future::ready;
use lsp_types::notification::{LogMessage, Progress, ShowMessage};
use lsp_types::request::{
    RegisterCapability, ShowMessageRequest, UnregisterCapability, WorkDoneProgressCreate, WorkspaceConfiguration,
    WorkspaceFoldersRequest,
};
use lsp_types::{OneOf, ServerCapabilities, WorkspaceFolder};
use serde_json::json;

use super::LspProcess;
use crate::lsp::configuration::configuration_items;
use crate::lsp::output::ServerOutput;
use crate::lsp::rpc::Connection;
use crate::lsp::shapes::{all_features, feature_of};
use crate::protocol::{LspFeature, LspState};

type Me = Weak<LspProcess>;

/// Answers what the server asks diffle and files what it tells it. A notification diffle has no
/// use for is dropped; a request it does not know is refused as the protocol says.
pub(super) fn listen(me: &Me, rpc: &Connection, folder: WorkspaceFolder) {
    let at = me.clone();
    rpc.on_request::<WorkspaceConfiguration>(move |params| {
        let settings = at.upgrade().and_then(|me| me.state.lock().unwrap().settings.clone());
        async move {
            let settings = match settings {
                Some(settings) => settings.await,
                None => json!({}),
            };
            Ok(configuration_items(&settings, &params.items))
        }
        .boxed()
    });
    rpc.on_request::<WorkspaceFoldersRequest>(move |()| ready(Ok(Some(vec![folder.clone()]))).boxed());
    let at = me.clone();
    rpc.on_request::<RegisterCapability>(move |params| {
        if let Some(me) = at.upgrade() {
            me.register(params.registrations.iter().map(|r| (r.id.as_str(), feature_of(&r.method))));
        }
        ready(Ok(())).boxed()
    });
    let at = me.clone();
    rpc.on_request::<UnregisterCapability>(move |params| {
        if let Some(me) = at.upgrade() {
            me.register(params.unregisterations.iter().map(|r| (r.id.as_str(), None)));
        }
        ready(Ok(())).boxed()
    });
    rpc.on_request::<WorkDoneProgressCreate>(|_| ready(Ok(())).boxed());
    let at = me.clone();
    rpc.on_request::<ShowMessageRequest>(move |params| {
        output(&at, |out| out.show(params.typ, &params.message));
        ready(Ok(None)).boxed()
    });
    let at = me.clone();
    rpc.on_notification::<LogMessage>(move |params| output(&at, |out| out.log(params.typ, &params.message)));
    let at = me.clone();
    rpc.on_notification::<ShowMessage>(move |params| output(&at, |out| out.show(params.typ, &params.message)));
    let at = me.clone();
    rpc.on_notification::<Progress>(move |params| output(&at, |out| out.progress(params)));
}

/// Hands what the server reported to its output while the process is live.
fn output(me: &Me, f: impl FnOnce(&mut ServerOutput)) {
    if let Some(me) = me.upgrade() {
        let live = {
            let state = me.state.lock().unwrap();
            !state.closing && state.current.state != LspState::Unavailable
        };
        if live {
            f(&mut me.output.lock().unwrap());
        }
    }
}

impl LspProcess {
    /// Features the server offers from now on, as an editor takes them, by registration id; an id
    /// with no feature withdraws what that id registered.
    fn register<'a>(self: &Arc<Self>, entries: impl Iterator<Item = (&'a str, Option<LspFeature>)>) {
        let status = {
            let mut state = self.state.lock().unwrap();
            for (id, feature) in entries {
                if let Some(feature) = feature {
                    state.registrations.insert(id.to_owned(), feature);
                    if !state.advertised.contains(&feature) {
                        state.advertised.push(feature);
                    }
                } else if let Some(feature) = state.registrations.remove(id) {
                    state.advertised.retain(|f| *f != feature);
                }
            }
            state.current.clone()
        };
        (self.on_status)(&status);
    }
}

/// The features `initialize` advertised: a provider that is `true` or carries options.
pub(super) fn advertised(caps: &ServerCapabilities) -> Vec<LspFeature> {
    fn on<T>(provider: &Option<OneOf<bool, T>>) -> bool {
        matches!(provider, Some(OneOf::Left(true) | OneOf::Right(_)))
    }
    use lsp_types::{HoverProviderCapability as Hover, TypeDefinitionProviderCapability as TypeDef};
    all_features()
        .into_iter()
        .filter(|f| match f {
            LspFeature::Definition => on(&caps.definition_provider),
            LspFeature::TypeDefinition => {
                matches!(caps.type_definition_provider, Some(TypeDef::Simple(true) | TypeDef::Options(_)))
            }
            LspFeature::Hover => matches!(caps.hover_provider, Some(Hover::Simple(true) | Hover::Options(_))),
            LspFeature::References => on(&caps.references_provider),
            LspFeature::DocumentSymbol => on(&caps.document_symbol_provider),
            LspFeature::WorkspaceSymbol => on(&caps.workspace_symbol_provider),
            LspFeature::DocumentHighlight => on(&caps.document_highlight_provider),
        })
        .collect()
}

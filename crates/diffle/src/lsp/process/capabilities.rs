//! What a server says it offers, its `initialize` capabilities and its (un)registrations since, and
//! the router answering what it sends diffle.
use std::ops::ControlFlow;
use std::sync::{Arc, Weak};

use async_lsp::lsp_types::notification::{LogMessage, Progress, ShowMessage};
use async_lsp::lsp_types::request::{
    RegisterCapability, ShowMessageRequest, UnregisterCapability, WorkDoneProgressCreate, WorkspaceConfiguration,
    WorkspaceFoldersRequest,
};
use async_lsp::lsp_types::{OneOf, ServerCapabilities, WorkspaceFolder};
use async_lsp::router::Router;
use futures::FutureExt;
use serde_json::json;

use super::LspProcess;
use crate::lsp::configuration::configuration_items;
use crate::lsp::output::ServerOutput;
use crate::lsp::shapes::{all_features, feature_of};
use crate::protocol::{LspFeature, LspState};

type Me = Weak<LspProcess>;

/// Answers what the server asks diffle and files what it tells it. A notification diffle has no
/// use for is dropped; a request it does not know is refused as the protocol says.
pub(super) fn router(me: Me, folder: WorkspaceFolder) -> Router<Me> {
    let mut router = Router::new(me);
    router
        .request::<WorkspaceConfiguration, _>(|me, params| {
            let settings = me.upgrade().and_then(|me| me.state.lock().unwrap().settings.clone());
            async move {
                let settings = match settings {
                    Some(settings) => settings.await,
                    None => json!({}),
                };
                Ok(configuration_items(&settings, &params.items))
            }
            .boxed()
        })
        .request::<WorkspaceFoldersRequest, _>(move |_, ()| std::future::ready(Ok(Some(vec![folder.clone()]))))
        .request::<RegisterCapability, _>(|me, params| {
            if let Some(me) = me.upgrade() {
                me.register(params.registrations.iter().map(|r| (r.id.as_str(), feature_of(&r.method))));
            }
            std::future::ready(Ok(()))
        })
        .request::<UnregisterCapability, _>(|me, params| {
            if let Some(me) = me.upgrade() {
                me.register(params.unregisterations.iter().map(|r| (r.id.as_str(), None)));
            }
            std::future::ready(Ok(()))
        })
        .request::<WorkDoneProgressCreate, _>(|_, _| std::future::ready(Ok(())))
        .request::<ShowMessageRequest, _>(|me, params| {
            output(me, |out| out.show(params.typ, &params.message));
            std::future::ready(Ok(None))
        })
        .notification::<LogMessage>(|me, params| filed(me, |out| out.log(params.typ, &params.message)))
        .notification::<ShowMessage>(|me, params| filed(me, |out| out.show(params.typ, &params.message)))
        .notification::<Progress>(|me, params| filed(me, |out| out.progress(params)))
        .unhandled_notification(|_, _| ControlFlow::Continue(()));
    router
}

/// `output` for a notification, which carries on the loop.
fn filed(me: &Me, f: impl FnOnce(&mut ServerOutput)) -> ControlFlow<async_lsp::Result<()>> {
    output(me, f);
    ControlFlow::Continue(())
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
    use async_lsp::lsp_types::{HoverProviderCapability as Hover, TypeDefinitionProviderCapability as TypeDef};
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

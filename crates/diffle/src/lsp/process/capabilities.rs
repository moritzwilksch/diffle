//! What a server says it offers: its `initialize` capabilities, its (un)registrations since, and
//! the requests it sends diffle.
use std::sync::Arc;

use futures::FutureExt;
use serde_json::{Value, json};

use super::LspProcess;
use crate::lsp::configuration::configuration_items;
use crate::lsp::rpc::{Connection, RpcError};
use crate::lsp::shapes::feature_of;
use crate::protocol::LspState;

impl LspProcess {
    pub(super) fn listen(self: &Arc<Self>, rpc: &Connection) {
        let me = Arc::downgrade(self);
        rpc.on_message(move |method, params| {
            let Some(me) = me.upgrade() else { return };
            let live = {
                let state = me.state.lock().unwrap();
                !state.closing && state.current.state != LspState::Unavailable
            };
            if live {
                me.output.lock().unwrap().message(method, params);
            }
        });
        let me = Arc::downgrade(self);
        rpc.on_request("workspace/configuration", move |params| {
            let settings = me.upgrade().and_then(|me| me.state.lock().unwrap().settings.clone());
            async move {
                let settings = match settings {
                    Some(settings) => settings.await,
                    None => json!({}),
                };
                configuration_items(&settings, &params).map(Value::Array)
            }
            .boxed()
        });
        for method in ["client/registerCapability", "client/unregisterCapability"] {
            let me = Arc::downgrade(self);
            let register = method == "client/registerCapability";
            rpc.on_request(method, move |params| {
                let answer = match me.upgrade() {
                    Some(me) => me.register(register, &params),
                    None => Ok(Value::Null),
                };
                async move { answer }.boxed()
            });
        }
    }

    /// A feature the server offers from now on, as an editor takes it, or one it withdraws.
    fn register(&self, register: bool, params: &Value) -> std::result::Result<Value, RpcError> {
        let (key, what) = if register { ("registrations", "register") } else { ("unregisterations", "unregister") };
        let invalid = || RpcError::new(-32602, format!("Invalid client/{what}Capability parameters"));
        let list = params.get(key).and_then(Value::as_array).ok_or_else(invalid)?;
        let mut entries = Vec::new();
        for entry in list {
            let id = entry.get("id").and_then(Value::as_str).ok_or_else(invalid)?;
            let method =
                if register { Some(entry.get("method").and_then(Value::as_str).ok_or_else(invalid)?) } else { None };
            entries.push((id.to_owned(), method));
        }
        let status = {
            let mut state = self.state.lock().unwrap();
            for (id, method) in entries {
                if let Some(feature) = method.and_then(feature_of) {
                    state.registrations.insert(id, feature);
                    if !state.advertised.contains(&feature) {
                        state.advertised.push(feature);
                    }
                } else if let Some(feature) = state.registrations.remove(&id).filter(|_| !register) {
                    state.advertised.retain(|f| *f != feature);
                }
            }
            state.current.clone()
        };
        (self.on_status)(&status);
        Ok(Value::Null)
    }
}

/// JavaScript truthiness of a capability: `true` or an options object, not `false`, `null` or 0.
pub(super) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

//! Settings servers are sent and asked for: the JSON schema catalog, and `workspace/configuration`.
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde_json::Value;

use super::rpc::RpcError;
use crate::persist::write_file_atomic;

pub const SCHEMA_CATALOG: &str = "https://www.schemastore.org/api/json/catalog.json";
/// How long a downloaded catalog answers before it is fetched again.
const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// An association the JSON server understands: an http(s) schema url and at least one file pattern.
fn association(entry: &Value) -> Option<Value> {
    let url = entry.get("url")?.as_str()?;
    let parsed = url::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none_or(str::is_empty) {
        return None;
    }
    let matches = entry.get("fileMatch")?.as_array()?;
    if matches.is_empty() || !matches.iter().all(Value::is_string) {
        return None;
    }
    Some(serde_json::json!({ "url": url, "fileMatch": matches }))
}

/// The catalog's valid entries, in the association format the JSON server reads.
pub fn schema_associations(v: &Value) -> Vec<Value> {
    let Some(schemas) = v.get("schemas").and_then(Value::as_array) else { return Vec::new() };
    schemas.iter().filter_map(association).collect()
}

fn default_cache() -> PathBuf {
    crate::persist::user_cache_dir().join("schemastore.json")
}

/// The schema catalog, cached for a day; the last good copy answers when offline.
pub async fn load_schema_catalog(cache_file: Option<PathBuf>) -> Vec<Value> {
    load_from(cache_file.unwrap_or_else(default_cache), SCHEMA_CATALOG).await
}

async fn load_from(cache_file: PathBuf, url: &str) -> Vec<Value> {
    let mut cached = Vec::new();
    if let Ok(text) = tokio::fs::read_to_string(&cache_file).await {
        cached = serde_json::from_str(&text).map(|v| schema_associations(&v)).unwrap_or_default();
        let fresh = tokio::fs::metadata(&cache_file)
            .await
            .and_then(|m| m.modified())
            .is_ok_and(|m| SystemTime::now().duration_since(m).is_ok_and(|age| age < MAX_AGE));
        if !cached.is_empty() && fresh {
            return cached;
        }
    }
    let Some(schemas) = download(url).await.filter(|s| !s.is_empty()) else { return cached };
    // A cache that cannot be written must not keep hover from working in a read-only environment.
    let text = serde_json::json!({ "schemas": schemas }).to_string() + "\n";
    let _ = write_file_atomic(&cache_file, &text).await;
    schemas
}

async fn download(url: &str) -> Option<Vec<Value>> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().ok()?;
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    Some(schema_associations(&response.json::<Value>().await.ok()?))
}

/// Answers a server's `workspace/configuration` request from `settings`: each requested section in
/// order, null for unknown sections, the whole tree for an omitted one. Params are untrusted JSON
/// from the server; malformed requests are refused before any settings are returned.
pub fn configuration_items(settings: &Value, params: &Value) -> Result<Vec<Value>, RpcError> {
    let invalid = || RpcError::new(-32602, "Invalid workspace/configuration parameters");
    let items = params.get("items").and_then(Value::as_array).ok_or_else(invalid)?;
    let mut sections = Vec::with_capacity(items.len());
    for item in items {
        if !item.is_object() {
            return Err(invalid());
        }
        match item.get("section") {
            None | Some(Value::Null) => sections.push(None),
            Some(Value::String(s)) => sections.push(Some(s.as_str())),
            Some(_) => return Err(invalid()),
        }
    }
    Ok(sections
        .into_iter()
        .map(|section| match section {
            None | Some("") => settings.clone(),
            Some(section) => section
                .split('.')
                .try_fold(settings, |value, part| value.as_object()?.get(part))
                .cloned()
                .unwrap_or(Value::Null),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schemas() -> Value {
        json!([{ "url": "https://example.com/schema.json", "fileMatch": ["package.json", "*.config.json"] }])
    }

    #[test]
    fn filters_malformed_catalog_entries_and_preserves_filename_patterns() {
        let mut entries = schemas().as_array().unwrap().clone();
        entries.extend([
            Value::Null,
            json!({ "url": "file:///secret", "fileMatch": ["*"] }),
            json!({ "url": "https://example.com" }),
            json!({ "url": "https://", "fileMatch": ["*"] }),
            json!({ "url": "https://example.com", "fileMatch": [] }),
            json!({ "url": "https://example.com", "fileMatch": [null] }),
        ]);
        assert_eq!(Value::Array(schema_associations(&json!({ "schemas": entries }))), schemas());
        for catalog in [Value::Null, json!([]), json!({}), json!({ "schemas": null })] {
            assert!(schema_associations(&catalog).is_empty(), "{catalog}");
        }
    }

    #[test]
    fn rejects_malformed_configuration_requests() {
        let cases = [
            Value::Null,
            json!({}),
            json!({ "items": null }),
            json!({ "items": [null] }),
            json!({ "items": [42] }),
            json!({ "items": [{ "section": false }] }),
        ];
        for params in cases {
            let e = configuration_items(&json!({}), &params).unwrap_err();
            assert_eq!(
                (e.code, e.message.as_str()),
                (-32602, "Invalid workspace/configuration parameters"),
                "{params}"
            );
        }
    }

    #[test]
    fn answers_whole_and_dotted_configuration_sections_in_request_order() {
        let settings = json!({ "yaml": { "hover": true }, "evenBetterToml": { "schema": { "enabled": true } } });
        let params = json!({ "items": [
            { "section": "yaml.hover" }, { "section": "evenBetterToml.schema.enabled" }, { "section": "missing" }, {}, { "section": "__proto__" },
        ] });
        let items = configuration_items(&settings, &params).unwrap();
        assert_eq!(Value::Array(items), json!([true, true, null, settings, null]));
    }

    #[tokio::test]
    async fn caches_discovery_avoids_fresh_downloads_and_falls_back_to_stale_data_offline() {
        use axum::routing::get;
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        let app = axum::Router::new().route(
            "/catalog.json",
            get(move || {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async { axum::Json(json!({ "schemas": schemas() })) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/catalog.json", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("catalog.json");
        assert_eq!(Value::Array(load_from(file.clone(), &url).await), schemas());
        assert_eq!(Value::Array(load_from(file.clone(), &url).await), schemas());
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        std::fs::File::options().write(true).open(&file).unwrap().set_modified(SystemTime::UNIX_EPOCH).unwrap();
        server.abort();
        let _ = server.await;
        // Offline: the stale copy answers.
        assert_eq!(Value::Array(load_from(file.clone(), &url).await), schemas());
        std::fs::write(&file, "invalid JSON").unwrap();
        assert!(load_from(file, &url).await.is_empty());
    }
}

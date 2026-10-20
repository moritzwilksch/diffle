//! Which hosts and origins may reach the API and the WebSocket.
use std::collections::HashSet;
use std::net::IpAddr;

const LOOPBACK: [&str; 3] = ["127.0.0.1", "::1", "localhost"];
const UNCONFIGURED: &str = "if a reverse proxy sent it, trust that origin with --allowed-origin";

/// Restricts API and WebSocket requests to local hosts and the configured public origin. Proxies
/// may preserve the public Host or rewrite it to an allowed upstream Host. Forwarded headers never
/// grant trust; a public Origin must be explicitly configured.
pub struct RequestGuard {
    loopback: bool,
    allowed: HashSet<String>,
    allowed_origin: Option<String>,
    public_host: Option<String>,
    /// Names the configured origin: it can differ from a rejected one only in the scheme.
    hint: String,
}

impl RequestGuard {
    pub fn new(bind_host: &str, names: &[String], allowed_origin: Option<&str>) -> Self {
        let mut allowed: HashSet<String> = LOOPBACK.iter().map(|h| (*h).to_owned()).collect();
        allowed.insert(bind_host.to_lowercase());
        allowed.extend(names.iter().map(|n| n.to_lowercase()));
        Self {
            loopback: LOOPBACK.contains(&bind_host),
            allowed,
            allowed_origin: allowed_origin.map(str::to_owned),
            public_host: allowed_origin.and_then(origin_host),
            hint: allowed_origin.map_or_else(|| UNCONFIGURED.to_owned(), |o| format!("allowed origin is \"{o}\"")),
        }
    }

    /// For a server bound to `bind_host` on this machine, which also answers to its own names.
    pub fn for_host(bind_host: &str, allowed_origin: Option<&str>) -> Self {
        Self::new(bind_host, &own_names(), allowed_origin)
    }

    /// None for an accepted request, or a message naming the header that failed and either the
    /// origin already trusted or how to trust one.
    pub fn check(&self, host: Option<&str>, origin: Option<&str>) -> Option<String> {
        let Some(host) = host else { return Some("missing Host header".into()) };
        let name = hostname_of(host).to_lowercase();
        let local = if self.loopback {
            LOOPBACK.contains(&name.as_str())
        } else {
            name.parse::<IpAddr>().is_ok() || self.allowed.contains(&name)
        };
        let proxy = self.public_host.as_deref().is_some_and(|p| host.eq_ignore_ascii_case(p));
        if !local && !proxy {
            return Some(format!("forbidden Host \"{host}\"; {}", self.hint));
        }
        let origin = origin?;
        if self.allowed_origin.as_deref() == Some(origin) {
            return None;
        }
        // A public Host must not make another scheme or port on that origin trusted.
        if !proxy && origin_host(origin).as_deref() == Some(host) {
            return None;
        }
        Some(format!("forbidden Origin \"{origin}\" for Host \"{host}\"; {}", self.hint))
    }
}

/// The `host[:port]` of a syntactically valid http(s) origin; none for `null` and other non-URLs.
fn origin_host(origin: &str) -> Option<String> {
    let rest = origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if authority.is_empty() {
        return None;
    }
    let lower = authority.to_lowercase();
    // URL.host drops a scheme's default port.
    let stripped = if origin.starts_with("http://") { lower.strip_suffix(":80") } else { lower.strip_suffix(":443") };
    Some(stripped.unwrap_or(&lower).to_owned())
}

/// The machine's hostname, its short form, and its mDNS name, so LAN visitors can use any of them.
fn own_names() -> Vec<String> {
    let full = gethostname::gethostname().to_string_lossy().into_owned();
    let short = full.split('.').next().unwrap_or_default().to_owned();
    vec![full, short.clone(), format!("{short}.local")]
}

/// Hostname without port; brackets stripped from IPv6 literals.
fn hostname_of(host: &str) -> &str {
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(rest);
    }
    // A bare IPv6 without brackets is not a valid Host header; treat it whole.
    if host.parse::<IpAddr>().is_ok() {
        return host;
    }
    host.rsplit_once(':').map_or(host, |(name, _)| name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> Vec<String> {
        vec!["box".into(), "box.local".into()]
    }

    #[test]
    fn a_loopback_server_takes_loopback_hosts_and_their_own_origins_only() {
        let g = RequestGuard::new("127.0.0.1", &names(), None);
        assert_eq!(g.check(Some("127.0.0.1:4966"), None), None);
        assert_eq!(g.check(Some("localhost:4966"), Some("http://localhost:4966")), None);
        assert_eq!(g.check(Some("[::1]:4966"), None), None);
        assert!(g.check(Some("box:4966"), None).unwrap().starts_with("forbidden Host \"box:4966\""));
        assert!(g.check(Some("evil.example"), None).is_some());
        let cross = g.check(Some("localhost:4966"), Some("http://evil.example")).unwrap();
        assert_eq!(
            cross,
            format!("forbidden Origin \"http://evil.example\" for Host \"localhost:4966\"; {UNCONFIGURED}")
        );
        assert_eq!(g.check(None, None).unwrap(), "missing Host header");
        assert!(g.check(Some("localhost:4966"), Some("null")).is_some());
    }

    #[test]
    fn a_network_server_takes_ips_and_its_names_and_a_configured_proxy_origin() {
        let g = RequestGuard::new("0.0.0.0", &names(), Some("https://review.example"));
        assert_eq!(g.check(Some("192.168.1.5:4966"), None), None);
        assert_eq!(g.check(Some("BOX.local:4966"), None), None);
        assert_eq!(g.check(Some("box.local:4966"), Some("http://BOX.local:4966")), None);
        assert_eq!(g.check(Some("review.example"), Some("https://review.example")), None);
        // A public Host does not make another scheme on it trusted.
        let other = g.check(Some("review.example"), Some("http://review.example")).unwrap();
        assert!(other.ends_with("allowed origin is \"https://review.example\""), "{other}");
        assert!(g.check(Some("elsewhere.example"), None).is_some());
    }
}

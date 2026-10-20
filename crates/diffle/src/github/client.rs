//! The GitHub client; for now only where a token for a host would come from.

/// The environment variables holding a token for `host`, in the order diffle reads them. gh's own
/// split: GitHub Enterprise Server tokens live apart from github.com and GHE.com ones.
pub fn token_variables(host: &str) -> [&'static str; 2] {
    if host == "github.com" || host.ends_with(".ghe.com") {
        ["GITHUB_TOKEN", "GH_TOKEN"]
    } else {
        ["GITHUB_ENTERPRISE_TOKEN", "GH_ENTERPRISE_TOKEN"]
    }
}

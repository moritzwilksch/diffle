//! The review's tour, as an agent pushes and clears it.
use reqwest::{Method, StatusCode};

use super::server::Diffle;
use crate::error::Error;
use crate::protocol::{Tour, TourPush, TourPushed, TourRejection};

/// Replaces the review's tour with `html`, telling each warning on stderr. A refusal is the agent's to
/// fix: a user error listing every reason.
pub async fn push(diffle: &Diffle, html: String) -> anyhow::Result<Tour> {
    let response = diffle.send(Method::PUT, "api/tour", Some(&TourPush { html })).await?;
    if response.status() == StatusCode::UNPROCESSABLE_ENTITY {
        let rejection: TourRejection = response.json().await?;
        let reasons: String = rejection.errors.iter().map(|e| format!("\n  {}: {}", e.element, e.message)).collect();
        return Err(Error::Invalid(format!("the tour was refused:{reasons}")).into());
    }
    let pushed: TourPushed = Diffle::success(response).await?.json().await?;
    if !pushed.warnings.is_empty() {
        crate::status!("⚠ the tour was shown, with warnings to judge:");
        for w in &pushed.warnings {
            crate::status!("  {}: {}", w.element, w.message);
        }
    }
    Ok(pushed.tour)
}

pub async fn clear(diffle: &Diffle) -> anyhow::Result<()> {
    Diffle::success(diffle.send(Method::DELETE, "api/tour", None::<&()>).await?).await?;
    Ok(())
}

//! Ending an auto-opened review once its browser is gone.
use std::time::Duration;

use tokio::sync::watch;

/// How long the last tab may stay gone before the review ends: a reload replaces its WebSocket within it.
pub const GRACE: Duration = Duration::from_secs(1);

/// Resolves once a browser has connected and the last one then stayed gone for `grace`. Never
/// resolves before the first connection, so a slow browser start cannot end the review.
pub async fn last_tab_closed(mut clients: watch::Receiver<usize>, grace: Duration) {
    let mut connected = false;
    loop {
        let count = *clients.borrow_and_update();
        if count > 0 {
            connected = true;
        } else if connected {
            match tokio::time::timeout(grace, clients.changed()).await {
                Err(_) => return,
                Ok(Ok(())) => continue,
                Ok(Err(_)) => break,
            }
        }
        if clients.changed().await.is_err() {
            break;
        }
    }
    // The hub went away: nothing can disconnect any more.
    std::future::pending::<()>().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn settle() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stops_after_the_last_browser_disconnects_and_survives_a_reload() {
        let (tx, rx) = watch::channel(0usize);
        let closed = tokio::spawn(last_tab_closed(rx, GRACE));
        // Never connected: no grace period starts.
        tokio::time::sleep(GRACE * 2).await;
        assert!(!closed.is_finished());
        tx.send(1).unwrap();
        settle().await;
        tx.send(0).unwrap();
        settle().await;
        tokio::time::sleep(GRACE / 2).await;
        // A reload reconnects within the grace period.
        tx.send(1).unwrap();
        settle().await;
        tokio::time::sleep(GRACE * 2).await;
        assert!(!closed.is_finished());
        tx.send(0).unwrap();
        settle().await;
        tokio::time::sleep(GRACE - Duration::from_millis(1)).await;
        assert!(!closed.is_finished());
        tokio::time::sleep(Duration::from_millis(2)).await;
        settle().await;
        assert!(closed.is_finished());
    }
}

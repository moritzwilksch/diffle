//! Checking out what an entered review shows, so language servers index its new side.
use std::sync::atomic::Ordering;

use super::Session;
use crate::cli::paint::dim;
use crate::error::{Error, Result};
use crate::git::{CheckoutTarget, WORKTREE};
use crate::protocol::{RangeView, Review};

/// A checkout this run made: where HEAD was before the first, and where the last one left it.
pub(super) struct MovedCheckout {
    from: CheckoutTarget,
    to: CheckoutTarget,
}

/// What entering a review did to the checkout, when there was something to check out.
enum Outcome {
    Switched,
    Skipped(&'static str),
    Refused(Error),
}

const DIRTY: &str = "the worktree has uncommitted changes";

impl Session {
    /// Checks out the new side of an entered review when the worktree is clean.
    /// Never fails the review: a dirty worktree or a refused switch leaves the checkout as it
    /// was, and the review is shown without language servers.
    pub(super) async fn check_out(&self, review: &Review) {
        if !self.checkout.load(Ordering::SeqCst) {
            return;
        }
        let target = match self.checkout_target(review).await {
            Ok(Some(target)) => target,
            Ok(None) => return,
            Err(e) => return report(CHECK_OUT, "the new side", Outcome::Refused(e)),
        };
        let outcome = match self.try_check_out(&target, relative_to_head(review)).await {
            Ok(None) => return,
            Ok(Some(outcome)) => outcome,
            Err(e) => Outcome::Refused(e),
        };
        report(CHECK_OUT, &label(&target), outcome);
    }

    /// None when HEAD already is `target`. A range naming HEAD is not moved off it: the review
    /// resolves its names again after the switch, and would then show a different range.
    async fn try_check_out(&self, target: &CheckoutTarget, relative: bool) -> Result<Option<Outcome>> {
        if self.repo.checked_out(target).await? {
            return Ok(None);
        }
        if relative {
            return Ok(Some(Outcome::Skipped("the range is relative to HEAD")));
        }
        if !self.repo.is_clean().await? {
            return Ok(Some(Outcome::Skipped(DIRTY)));
        }
        let head = self.repo.current_checkout().await?;
        self.repo.switch(target).await?;
        let mut moved = self.moved_checkout.lock().unwrap();
        // An unborn HEAD has nothing to go back to.
        if let Some(from) = moved.take().map(|m| m.from).or(head) {
            *moved = Some(MovedCheckout { from, to: target.clone() });
        }
        Ok(Some(Outcome::Switched))
    }

    /// Puts HEAD back where it was before this run's first checkout, unless the reviewer moved it
    /// since or left uncommitted changes, which a switch would carry onto the other branch.
    pub(super) async fn restore_checkout(&self) {
        self.checkout.store(false, Ordering::SeqCst);
        let Some(MovedCheckout { from, to }) = self.moved_checkout.lock().unwrap().take() else { return };
        let target = label(&from);
        let outcome = async {
            if !self.repo.checked_out(&to).await? || self.repo.checked_out(&from).await? {
                return Ok(None);
            }
            if !self.repo.is_clean().await? {
                return Ok(Some(Outcome::Skipped(DIRTY)));
            }
            self.repo.switch(&from).await?;
            Ok::<_, Error>(Some(Outcome::Switched))
        };
        match outcome.await {
            Ok(None) => {}
            Ok(Some(outcome)) => report(BACK, &target, outcome),
            Err(e) => report(BACK, &target, Outcome::Refused(e)),
        }
    }

    /// A local branch, switched to; any other commit on the new side (a pull request's head, a
    /// remote branch, a branch another worktree holds, a tag, a hash, an expression, a lone
    /// commit), detached at. A range with the worktree on either side, a slice of a range and a
    /// range-diff are left alone.
    async fn checkout_target(&self, review: &Review) -> Result<Option<CheckoutTarget>> {
        let new = match review {
            Review::Commit { sha } => return Ok(Some(CheckoutTarget::Detached(sha.clone()))),
            // The worktree on either side is what a switch would rewrite.
            Review::Range { old, new, view: RangeView::Whole, .. } if old != WORKTREE && new != WORKTREE => new,
            Review::Range { .. } => return Ok(None),
        };
        // A pull request's head lives under refs/diffle/, which names no branch. A branch another
        // worktree holds cannot be switched to, but its commit can be checked out.
        if let Some(branch) = self.repo.branch_ref(new).await?.as_deref().and_then(|r| r.strip_prefix("refs/heads/"))
            && !self.repo.checked_out_elsewhere(branch).await?
        {
            return Ok(Some(CheckoutTarget::Branch(branch.to_owned())));
        }
        Ok(Some(CheckoutTarget::Detached(self.repo.resolve(new).await?)))
    }
}

/// How a status line words a switch that happened, and one that did not.
const CHECK_OUT: (&str, &str) = ("checked out", "not checked out");
const BACK: (&str, &str) = ("back on", "not back on");

/// One status line, in the startup lines' shape: what happened, dimmed, then the target.
fn report((done, skipped): (&str, &str), target: &str, outcome: Outcome) {
    let why = match outcome {
        Outcome::Switched => return crate::status!("🔀 {} {target}", dim(done)),
        Outcome::Skipped(why) => why.to_owned(),
        Outcome::Refused(e) => reason(&e),
    };
    crate::status!("🔀 {} {target} {}", dim(skipped), dim(&format!("({why})")));
}

/// Git's own words for a refusal: the first line of its stderr, without the `fatal:` or `error:`.
fn reason(e: &Error) -> String {
    let text = match e {
        Error::Git(git) if !git.stderr.trim().is_empty() => git.stderr.clone(),
        e => e.to_string(),
    };
    let line = text.trim().lines().next().unwrap_or_default();
    line.strip_prefix("fatal: ").or_else(|| line.strip_prefix("error: ")).unwrap_or(line).to_owned()
}

/// Whether either end of a range is named after HEAD: `HEAD`, `HEAD~2`, `@`, `@{u}`.
fn relative_to_head(review: &Review) -> bool {
    let Review::Range { old, new, .. } = review else { return false };
    [old, new].iter().any(|rev| rev.starts_with("HEAD") || rev.starts_with('@'))
}

fn label(target: &CheckoutTarget) -> String {
    match target {
        CheckoutTarget::Branch(name) => name.clone(),
        CheckoutTarget::Detached(sha) => format!("{} (detached)", &sha[..sha.len().min(12)]),
    }
}

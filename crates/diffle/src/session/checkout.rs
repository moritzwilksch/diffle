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

/// Where a review puts the checkout.
enum Target {
    Move(CheckoutTarget),
    /// What it shows is checked out already: the worktree, a slice of it, or HEAD's commit.
    Stay,
    /// It names no one revision to check out, for this reason.
    Skip(&'static str),
}

/// What entering a review did to the checkout, when there was something to check out.
enum Outcome {
    Switched,
    Skipped(&'static str),
    Refused(Error),
}

const DIRTY: &str = "the worktree has uncommitted changes";

impl Session {
    /// Checks out the new side of an entered review when the worktree is clean, and says why
    /// when it does not. Never fails the review: a dirty worktree or a refused switch leaves the
    /// checkout as it was, and the review is shown without language servers.
    pub(super) async fn check_out(&self, review: &Review) {
        if !self.checkout.load(Ordering::SeqCst) {
            return;
        }
        let target = match self.checkout_target(review).await {
            Ok(Target::Move(target)) => target,
            Ok(Target::Stay) => return,
            Ok(Target::Skip(why)) => return report(CHECK_OUT, "the new side", Outcome::Skipped(why)),
            Err(e) => return report(CHECK_OUT, "the new side", Outcome::Refused(e)),
        };
        let outcome = match self.try_check_out(&target).await {
            Ok(None) => return,
            Ok(Some(outcome)) => outcome,
            Err(e) => Outcome::Refused(e),
        };
        report(CHECK_OUT, &label(&target), outcome);
    }

    /// None when HEAD already is `target`. While HEAD is elsewhere, a review named after HEAD
    /// keeps naming where the reviewer left it (`HeadPin`).
    async fn try_check_out(&self, target: &CheckoutTarget) -> Result<Option<Outcome>> {
        if self.repo.checked_out(target).await? {
            return Ok(None);
        }
        if !self.repo.is_clean().await? {
            return Ok(Some(Outcome::Skipped(DIRTY)));
        }
        let head = self.repo.current_checkout().await?;
        self.repo.switch(target).await?;
        let mut moved = self.moved_checkout.lock().unwrap();
        // An unborn HEAD has nothing to go back to.
        let from = moved.take().map(|m| m.from).or(head).filter(|from| from != target);
        match &from {
            Some(from) => self.head.hold(pin(from)),
            None => self.head.release(),
        }
        *moved = from.map(|from| MovedCheckout { from, to: target.clone() });
        Ok(Some(Outcome::Switched))
    }

    /// Keeps a checkout this run made on the new side once its refs moved, unless the reviewer
    /// moved HEAD since: the review is theirs to read, the checkout theirs to take back.
    pub(super) async fn follow_checkout(&self, review: &Review) {
        if self.holds_checkout().await {
            self.check_out(review).await;
        }
    }

    /// Whether HEAD is still where this run's last checkout left it. Once the reviewer moved it,
    /// it is theirs: nothing to put back on exit, and HEAD in a review names HEAD again.
    pub(super) async fn holds_checkout(&self) -> bool {
        let Some(to) = self.moved_checkout.lock().unwrap().as_ref().map(|m| m.to.clone()) else { return false };
        if matches!(self.repo.checked_out(&to).await, Ok(false)) {
            *self.moved_checkout.lock().unwrap() = None;
            self.head.release();
            return false;
        }
        true
    }

    /// Puts HEAD back where it was before this run's first checkout, unless the reviewer moved it
    /// since or left uncommitted changes, which a switch would carry onto the other branch.
    pub(super) async fn restore_checkout(&self) {
        self.checkout.store(false, Ordering::SeqCst);
        let Some(MovedCheckout { from, to }) = self.moved_checkout.lock().unwrap().take() else { return };
        self.head.release();
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
    /// commit, one commit focused within a range, the worktree's included), detached at. While this
    /// run holds HEAD elsewhere, a range ending at the worktree, or its uncommitted changes, goes
    /// back to where the reviewer left it. The worktree as the old side and an interdiff are skipped.
    async fn checkout_target(&self, review: &Review) -> Result<Target> {
        if let Review::Range { old, .. } = review
            && old == WORKTREE
        {
            return Ok(Target::Skip("the worktree is the old side"));
        }
        let new = match &self.head.apply(review) {
            Review::Commit { sha } => return Ok(Target::Move(CheckoutTarget::Detached(self.repo.resolve(sha).await?))),
            Review::Range { view: RangeView::Commit { sha }, .. } => {
                return Ok(Target::Move(CheckoutTarget::Detached(sha.clone())));
            }
            Review::Range { view: RangeView::Interdiff { .. }, .. } => {
                return Ok(Target::Skip("an interdiff shows no one revision"));
            }
            Review::Range { new, .. } if new == WORKTREE => return Ok(Target::Stay),
            Review::Range { new, .. } => new.clone(),
        };
        let new = &new;
        // A pull request's head lives under refs/diffle/, which names no branch. A branch another
        // worktree holds cannot be switched to, but its commit can be checked out.
        if let Some(branch) = self.repo.branch_ref(new).await?.as_deref().and_then(|r| r.strip_prefix("refs/heads/"))
            && !self.repo.checked_out_elsewhere(branch).await?
        {
            return Ok(Target::Move(CheckoutTarget::Branch(branch.to_owned())));
        }
        Ok(Target::Move(CheckoutTarget::Detached(self.repo.resolve(new).await?)))
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

/// A refusal in a status line: its first line. An unexpected failure keeps its causes, which its
/// outermost context alone would not name.
fn reason(e: &Error) -> String {
    let text = match e {
        Error::Other(e) => format!("{e:#}"),
        e => e.to_string(),
    };
    text.trim().lines().next().unwrap_or_default().to_owned()
}

/// What HEAD named before this run moved it: the branch it was on, or its commit.
fn pin(from: &CheckoutTarget) -> String {
    match from {
        CheckoutTarget::Branch(name) | CheckoutTarget::Detached(name) => name.clone(),
    }
}

fn label(target: &CheckoutTarget) -> String {
    match target {
        CheckoutTarget::Branch(name) => name.clone(),
        CheckoutTarget::Detached(sha) => format!("{} (detached)", &sha[..sha.len().min(12)]),
    }
}

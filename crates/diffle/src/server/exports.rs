//! Tour exports the server asks an open tab to bake: only the browser has the highlighter. Each
//! request waits for the first tab to answer it.
use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::oneshot;

use crate::protocol::TourExportAnswer;

#[derive(Default)]
pub struct Exports {
    pending: Mutex<HashMap<String, oneshot::Sender<TourExportAnswer>>>,
}

/// One export waiting for its answer; dropping it forgets the request, so a late answer finds none.
pub struct Pending<'a> {
    exports: &'a Exports,
    pub id: String,
    pub answer: oneshot::Receiver<TourExportAnswer>,
}

impl Exports {
    /// Opens a request for the tabs to answer under its `id`.
    pub fn ask(&self) -> Pending<'_> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().expect("exports lock").insert(id.clone(), tx);
        Pending { exports: self, id, answer: rx }
    }

    /// Hands `answer` to request `id`; false when it was answered already or is gone.
    pub fn answer(&self, id: &str, answer: TourExportAnswer) -> bool {
        let sender = self.pending.lock().expect("exports lock").remove(id);
        sender.is_some_and(|tx| tx.send(answer).is_ok())
    }
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.exports.pending.lock().expect("exports lock").remove(&self.id);
    }
}

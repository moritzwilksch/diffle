//! Per-phase startup timings, printed with --timing.
use std::time::Instant;

pub struct Timing {
    enabled: bool,
    start: Instant,
    marks: Vec<(&'static str, f64)>,
}

impl Timing {
    pub fn new(enabled: bool) -> Self {
        Self { enabled, start: Instant::now(), marks: Vec::new() }
    }

    pub fn mark(&mut self, name: &'static str) {
        if self.enabled {
            self.marks.push((name, self.start.elapsed().as_secs_f64() * 1000.0));
        }
    }

    pub fn report(&self) {
        if !self.enabled {
            return;
        }
        let width = self.marks.iter().map(|(n, _)| n.len()).max().unwrap_or(0);
        let mut prev = 0.0;
        for (name, ms) in &self.marks {
            crate::status!("[timing] {name:<width$}  +{:>7.1} ms  @{ms:>7.1} ms", ms - prev);
            prev = *ms;
        }
    }
}

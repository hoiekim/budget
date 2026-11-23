//! An async work queue with a sliding-window rate gate and a concurrency
//! cap: `src/common/utils/Queue.ts`. Built for rate-limited external APIs:
//! only the operation that actually consumes a slot goes through it.

use std::collections::VecDeque;
use std::fmt;
use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::Semaphore;

use crate::js::JsDate;

/// The rate gate could not produce a slot within the wait budget. A caller
/// someone is waiting on should surface a retryable failure.
#[derive(Debug, Clone, Copy)]
pub struct QueueWaitTimeoutError {
    pub waited_ms: f64,
}

impl fmt::Display for QueueWaitTimeoutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "No rate slot available within {}ms", crate::js::number_to_string(self.waited_ms))
    }
}

impl std::error::Error for QueueWaitTimeoutError {}

pub struct Queue {
    /// Tasks that may start per window; zero or less disables the rate gate.
    /// A function, so an environment-driven cap is read on every `add`.
    capacity: Box<dyn Fn() -> i64 + Send + Sync>,
    window_ms: f64,
    timestamps: Mutex<VecDeque<f64>>,
    /// `None` leaves concurrency unbounded.
    inflight: Option<Semaphore>,
    default_max_wait_ms: f64,
}

impl Queue {
    pub fn new(capacity: impl Fn() -> i64 + Send + Sync + 'static, window_ms: f64) -> Self {
        Queue {
            capacity: Box::new(capacity),
            window_ms,
            timestamps: Mutex::new(VecDeque::new()),
            inflight: None,
            default_max_wait_ms: 0.0,
        }
    }

    /// At most `max` tasks run at once.
    pub fn with_max_inflight(mut self, max: usize) -> Self {
        self.inflight = if max > 0 { Some(Semaphore::new(max)) } else { None };
        self
    }

    /// Runs `task` once the gates allow it. `max_wait_ms` bounds the wait for
    /// a rate slot (`None` takes the queue's default; zero or less waits indefinitely).
    pub async fn add<T, F, Fut>(&self, task: F, max_wait_ms: Option<f64>) -> Result<T, QueueWaitTimeoutError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        self.wait_for_rate_slot(max_wait_ms.unwrap_or(self.default_max_wait_ms)).await?;
        let _permit = match &self.inflight {
            Some(semaphore) => semaphore.acquire().await.ok(),
            None => None,
        };
        Ok(task().await)
    }

    async fn wait_for_rate_slot(&self, max_wait_ms: f64) -> Result<(), QueueWaitTimeoutError> {
        let cap = (self.capacity)();
        if cap <= 0 {
            return Ok(());
        }
        let deadline = if max_wait_ms > 0.0 { JsDate::now_ms() + max_wait_ms } else { f64::INFINITY };
        loop {
            let now = JsDate::now_ms();
            let sleep_ms = {
                let mut timestamps = self.timestamps.lock().unwrap();
                let cutoff = now - self.window_ms;
                while timestamps.front().map(|oldest| *oldest <= cutoff).unwrap_or(false) {
                    timestamps.pop_front();
                }
                if (timestamps.len() as i64) < cap {
                    timestamps.push_back(now);
                    return Ok(());
                }
                let frees_at = timestamps[0] + self.window_ms;
                if frees_at > deadline {
                    return Err(QueueWaitTimeoutError { waited_ms: max_wait_ms });
                }
                (frees_at - now).max(10.0)
            };
            tokio::time::sleep(Duration::from_millis(sleep_ms as u64)).await;
        }
    }

    /// Forgets every slot counted so far.
    pub fn reset(&self) {
        self.timestamps.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_full_window_times_out_within_the_budget() {
        let queue = Queue::new(|| 1, 60_000.0);
        assert_eq!(queue.add(|| async { 1 }, None).await.unwrap(), 1);
        let error = queue.add(|| async { 2 }, Some(50.0)).await.unwrap_err();
        assert_eq!(error.to_string(), "No rate slot available within 50ms");
    }

    #[tokio::test]
    async fn a_zero_capacity_disables_the_gate() {
        let queue = Queue::new(|| 0, 60_000.0);
        for i in 0..20 {
            assert_eq!(queue.add(|| async move { i }, Some(1.0)).await.unwrap(), i);
        }
    }
}

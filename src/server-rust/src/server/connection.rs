//! The life of one client connection, kept the way `Bun.serve` keeps it.
//!
//! - **Idle timeout.** A connection on which nothing is read or written for
//!   10 seconds is closed, whether it waits between requests or a handler is
//!   still working on its answer. A route that holds a response open with
//!   long silences between writes (the event stream) widens the deadline for
//!   its own connection, as the TypeScript route does with
//!   `server.timeout(request, seconds)`.
//! - **Handlers run to completion.** A handler keeps running when its client
//!   goes away or its connection is closed: what it writes is written, only
//!   the answer has nobody to go to. Each one runs as a task of its own,
//!   counted while it runs, so a shutdown can wait for those in flight.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::Notify;
use tokio::time::Instant;

/// `Bun.serve`'s default `idleTimeout`, in seconds.
pub const DEFAULT_IDLE_TIMEOUT_SECONDS: u64 = 10;

/// The longest idle timeout `Bun.serve` takes, in seconds.
pub const MAX_IDLE_TIMEOUT_SECONDS: u64 = 255;

struct Activity {
    started: Instant,
    /// Milliseconds after `started` of the last byte read or written.
    last_ms: AtomicU64,
    /// Seconds of silence after which the connection closes; 0 never.
    timeout_seconds: AtomicU64,
}

/// The idle deadline of one connection, shared by its socket and the requests on it.
#[derive(Clone)]
pub struct IdleTimeout(Arc<Activity>);

impl Default for IdleTimeout {
    fn default() -> Self {
        IdleTimeout(Arc::new(Activity {
            started: Instant::now(),
            last_ms: AtomicU64::new(0),
            timeout_seconds: AtomicU64::new(DEFAULT_IDLE_TIMEOUT_SECONDS),
        }))
    }
}

impl IdleTimeout {
    /// `server.timeout(request, seconds)`: from now on the connection may stay
    /// silent this long; 0 lets it stay silent forever. Capped at 255 seconds.
    pub fn set(&self, seconds: u64) {
        self.0.timeout_seconds.store(seconds.min(MAX_IDLE_TIMEOUT_SECONDS), Ordering::Relaxed);
        self.touch();
    }

    fn touch(&self) {
        let elapsed = self.0.started.elapsed().as_millis() as u64;
        self.0.last_ms.store(elapsed, Ordering::Relaxed);
    }

    /// How long until the connection has been silent for its timeout; zero once it has.
    /// `None` while it has no timeout.
    fn remaining(&self) -> Option<Duration> {
        let timeout_ms = self.0.timeout_seconds.load(Ordering::Relaxed) * 1000;
        if timeout_ms == 0 {
            return None;
        }
        let silent_ms = (self.0.started.elapsed().as_millis() as u64).saturating_sub(self.0.last_ms.load(Ordering::Relaxed));
        Some(Duration::from_millis(timeout_ms.saturating_sub(silent_ms)))
    }

    /// Drives `connection` until it ends or stays silent past its idle
    /// timeout. Dropping it then closes the socket; handlers it started keep running.
    pub async fn serve<F: std::future::Future>(&self, connection: F) {
        tokio::pin!(connection);
        loop {
            // A connection with no timeout looks again later: a route may set one.
            let wait = self.remaining().unwrap_or(Duration::from_secs(MAX_IDLE_TIMEOUT_SECONDS));
            if wait.is_zero() {
                return;
            }
            tokio::select! {
                _ = &mut connection => return,
                _ = tokio::time::sleep(wait) => {}
            }
        }
    }
}

/// A socket that tells its `IdleTimeout` whenever a byte goes in or out.
pub struct Tracked<T> {
    inner: T,
    idle: IdleTimeout,
}

impl<T> Tracked<T> {
    pub fn new(inner: T, idle: IdleTimeout) -> Self {
        idle.touch();
        Tracked { inner, idle }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for Tracked<T> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(result, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.idle.touch();
        }
        result
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for Tracked<T> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write(cx, buf);
        if matches!(result, Poll::Ready(Ok(written)) if written > 0) {
            self.idle.touch();
        }
        result
    }

    fn poll_write_vectored(mut self: Pin<&mut Self>, cx: &mut Context<'_>, bufs: &[io::IoSlice<'_>]) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write_vectored(cx, bufs);
        if matches!(result, Poll::Ready(Ok(written)) if written > 0) {
            self.idle.touch();
        }
        result
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
static SETTLED: Notify = Notify::const_new();

/// Counts a handler from the moment it starts until it is dropped.
struct InFlight;

impl InFlight {
    fn start() -> Self {
        IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        InFlight
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if IN_FLIGHT.fetch_sub(1, Ordering::SeqCst) == 1 {
            SETTLED.notify_waiters();
        }
    }
}

/// Runs `handler` as a task of its own, so it finishes even when the
/// connection that asked for it is dropped. `None` when it panicked.
pub async fn run_to_completion<F>(handler: F) -> Option<F::Output>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    let counted = InFlight::start();
    let task = tokio::spawn(async move {
        let _counted = counted;
        handler.await
    });
    task.await.ok()
}

/// Waits until no handler is running, or `limit` has passed. Whether they all finished.
pub async fn settle(limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        let settled = SETTLED.notified();
        tokio::pin!(settled);
        // Registered before the count is read, so a handler ending in between still wakes it.
        settled.as_mut().enable();
        if IN_FLIGHT.load(Ordering::SeqCst) == 0 {
            return true;
        }
        if tokio::time::timeout_at(deadline, settled).await.is_err() {
            return IN_FLIGHT.load(Ordering::SeqCst) == 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test(start_paused = true)]
    async fn a_silent_connection_closes_after_its_timeout() {
        let idle = IdleTimeout::default();
        let started = Instant::now();
        idle.serve(std::future::pending::<()>()).await;
        assert_eq!(started.elapsed().as_secs(), DEFAULT_IDLE_TIMEOUT_SECONDS);
    }

    #[tokio::test(start_paused = true)]
    async fn traffic_and_a_wider_timeout_push_the_deadline_back() {
        let (client, server) = tokio::io::duplex(64);
        let idle = IdleTimeout::default();
        let mut tracked = Tracked::new(server, idle.clone());
        let mut client = client;
        let started = Instant::now();
        let traffic = async {
            for _ in 0..3 {
                tokio::time::sleep(Duration::from_secs(6)).await;
                client.write_all(b"x").await.unwrap();
                let mut byte = [0u8; 1];
                tracked.read_exact(&mut byte).await.unwrap();
            }
            idle.set(30);
            std::future::pending::<()>().await
        };
        idle.serve(traffic).await;
        // Three reads 6 s apart, then 30 s of silence under the wider timeout.
        assert_eq!(started.elapsed().as_secs(), 18 + 30);
    }

    #[tokio::test(start_paused = true)]
    async fn no_timeout_never_closes_on_its_own() {
        let idle = IdleTimeout::default();
        idle.set(0);
        let finished = tokio::time::timeout(Duration::from_secs(3600), idle.serve(std::future::pending::<()>())).await;
        assert!(finished.is_err());
    }

    #[tokio::test]
    async fn a_handler_outlives_its_caller_and_settle_waits_for_it() {
        let (done_sender, done) = tokio::sync::oneshot::channel();
        let caller = tokio::spawn(run_to_completion(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let _ = done_sender.send(());
        }));
        tokio::time::sleep(Duration::from_millis(5)).await;
        caller.abort();
        assert!(settle(Duration::from_secs(5)).await);
        assert!(done.await.is_ok());
    }
}

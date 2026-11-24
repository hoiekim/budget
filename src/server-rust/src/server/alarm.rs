//! Discord alarms for server errors, under a per-key cooldown and a global
//! per-window ceiling: `src/server/lib/alarm.ts`.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde_json::json;

use crate::js::{js_slice_start, JsDate};
use crate::server::logger;

const COOLDOWN_MS: f64 = 60_000.0;

/// Ceiling on webhook POSTs per cooldown window across all keys.
pub const MAX_SENDS_PER_WINDOW: usize = 10;

/// Slots at the top of the ceiling that only single-shot sources (the crash handlers) may take.
pub const SINGLE_SHOT_RESERVE: usize = 2;

struct State {
    last_alarm_at: HashMap<String, f64>,
    send_timestamps: Vec<f64>,
}

static STATE: LazyLock<Mutex<State>> =
    LazyLock::new(|| Mutex::new(State { last_alarm_at: HashMap::new(), send_timestamps: Vec::new() }));

/// The shared HTTP client for outbound calls. It honours `HTTPS_PROXY` and the
/// system certificate store (`SSL_CERT_FILE`). An error when no client can be
/// built: see [`build_client`].
pub fn http_client() -> anyhow::Result<&'static reqwest::Client> {
    static CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| build_client("shared", |builder| builder));
    CLIENT.as_ref().map_err(anyhow::Error::msg)
}

/// Builds the HTTP client `configure` sets up, on the system certificate store.
///
/// That fails when no CA certificate can be read: `SSL_CERT_FILE` names a file
/// the process cannot read, or the image has no `ca-certificates`. The client
/// then trusts no certificate, so every https call fails with a certificate
/// error, as the Bun server's calls do there, and plain http calls still work.
/// A client that cannot be built even so is the error every call answers with.
/// Either is logged here, once per client.
pub fn build_client(name: &str, configure: fn(reqwest::ClientBuilder) -> reqwest::ClientBuilder) -> Result<reqwest::Client, String> {
    let no_store = match configure(reqwest::Client::builder()).build() {
        Ok(client) => return Ok(client),
        Err(error) => anyhow::Error::new(error),
    };
    match configure(reqwest::Client::builder()).tls_certs_only([]).build() {
        Ok(client) => {
            logger::error(
                "The HTTP client has no CA certificates: every https call will fail",
                Some(&crate::ctx! { "client": name }),
                Some(&no_store),
            );
            Ok(client)
        }
        Err(error) => {
            let error = anyhow::Error::new(error);
            logger::error(
                "The HTTP client could not be built: every outbound call will fail",
                Some(&crate::ctx! { "client": name }),
                Some(&error),
            );
            Err(format!("The HTTP client could not be built: {error:#}"))
        }
    }
}

/// Sends a Discord webhook alarm. Never fails: a delivery failure is logged.
///
/// `key` is the cooldown bucket and defaults to `title`. `single_shot` lets a
/// source that fires once and is never retried use the reserved slots.
pub async fn send_alarm(title: &str, detail: &str, key: Option<&str>, single_shot: bool) {
    let Some(webhook_url) = std::env::var("DISCORD_ALARM_WEBHOOK").ok().filter(|url| !url.is_empty()) else {
        return;
    };
    let key = key.unwrap_or(title);
    let now = JsDate::now_ms();
    {
        let mut state = STATE.lock().unwrap();
        let cutoff = now - COOLDOWN_MS;
        state.last_alarm_at.retain(|_, at| *at > cutoff);
        state.send_timestamps.retain(|at| *at > cutoff);

        let last = state.last_alarm_at.get(key).copied().unwrap_or(0.0);
        if now - last < COOLDOWN_MS {
            return;
        }
        let ceiling = if single_shot { MAX_SENDS_PER_WINDOW } else { MAX_SENDS_PER_WINDOW - SINGLE_SHOT_RESERVE };
        if state.send_timestamps.len() >= ceiling {
            logger::warn(
                "Discord alarm dropped — global rate ceiling reached",
                Some(&crate::ctx! {
                    "key": key,
                    "title": title,
                    "lane": if single_shot { "single-shot" } else { "recurring" },
                    "ceiling": ceiling,
                    "windowSends": state.send_timestamps.len(),
                }),
                None,
            );
            return;
        }
        state.last_alarm_at.insert(key.to_string(), now);
        state.send_timestamps.push(now);
    }

    let body = json!({
        "embeds": [{
            "title": format!("🚨 Budget Server Error: {title}"),
            "description": js_slice_start(detail, 4000),
            "color": 0xff0000,
            "timestamp": JsDate::now().to_json(),
        }],
    });
    let sent = match http_client() {
        Ok(client) => client.post(&webhook_url).json(&body).send().await.map_err(anyhow::Error::new),
        Err(error) => Err(error),
    };
    match sent {
        Ok(response) if !response.status().is_success() => {
            logger::error(
                "Discord alarm rejected by webhook",
                Some(&crate::ctx! { "key": key, "title": title, "status": response.status().as_u16() }),
                None,
            );
        }
        Ok(_) => {}
        Err(error) => {
            logger::error(
                "Failed to send Discord alarm",
                Some(&crate::ctx! { "key": key, "title": title }),
                Some(&error),
            );
        }
    }
}

/// Max time a crash path waits for its alarm to reach Discord before the process exits anyway.
pub const CRASH_ALARM_TIMEOUT: Duration = Duration::from_millis(5_000);

/// The alarm body for a crash: message plus a bounded stack.
pub fn format_crash_detail(message: &str, stack: &str) -> String {
    format!("**Message:** {}\n```\n{}\n```", message, js_slice_start(stack, 1000))
}

/// Sends a crash alarm in the single-shot lane and waits for it, bounded.
pub async fn deliver_crash_alarm(title: &str, message: &str, stack: &str) {
    let detail = format_crash_detail(message, stack);
    let _ = tokio::time::timeout(CRASH_ALARM_TIMEOUT, send_alarm(title, &detail, Some(title), true)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_client_that_cannot_be_built_is_an_error() {
        // No TLS version is both at least 1.3 and at most 1.2.
        let built = build_client("test", |builder| {
            builder.tls_version_min(reqwest::tls::Version::TLS_1_3).tls_version_max(reqwest::tls::Version::TLS_1_2)
        });
        assert_eq!(built.unwrap_err(), "The HTTP client could not be built: builder error: empty supported tls versions");
    }

    /// Elsewhere the client verifies against the system's own trust store,
    /// which `SSL_CERT_FILE` does not replace.
    #[cfg(target_os = "linux")]
    mod without_ca_certificates {
        use super::*;
        use crate::server::polygon::fetch_with_retry;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        /// Set in the child process the test starts.
        const CHILD: &str = "BUDGET_TEST_NO_CA_CERTIFICATES";

        /// The process builds its client once, so this runs in a child process
        /// of its own: the test binary again, running this test alone, with
        /// `SSL_CERT_FILE` naming an empty file.
        #[test]
        fn outbound_calls_fail_instead_of_panicking() {
            if std::env::var_os(CHILD).is_some() {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                return runtime.block_on(calls());
            }
            let store = std::env::temp_dir().join(format!("budget-no-ca-certificates-{}.pem", std::process::id()));
            std::fs::write(&store, "").unwrap();
            let (_crate, path) = module_path!().split_once("::").unwrap();
            let test = format!("{path}::outbound_calls_fail_instead_of_panicking");
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child.args(["--exact", &test, "--nocapture"]).env(CHILD, "1").env("SSL_CERT_FILE", &store).env_remove("SSL_CERT_DIR");
            // The calls go straight to the test's own listener.
            for proxy in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
                child.env_remove(proxy);
            }
            let output = child.output().unwrap();
            std::fs::remove_file(&store).unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(output.status.success() && stdout.contains("1 passed"), "{stdout}\n{stderr}");
            // Once, however many calls asked for the client.
            assert_eq!(stderr.matches("The HTTP client has no CA certificates").count(), 1, "{stderr}");
        }

        async fn calls() {
            // The store is what fails: no client can be built on it.
            let refused = anyhow::Error::new(reqwest::Client::builder().build().unwrap_err());
            assert!(format!("{refused:#}").contains("No CA certificates were loaded from the system"), "{refused:#}");

            // A listener that answers every connection with an empty HTTP response.
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            tokio::spawn(async move {
                while let Ok((mut socket, _)) = listener.accept().await {
                    let mut request = [0; 1024];
                    let _ = socket.read(&mut request).await;
                    let _ = socket.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n").await;
                }
            });

            // An https call is an error, not a panic (the listener does not speak TLS)...
            let https = format!("https://{address}/");
            assert!(http_client().unwrap().get(&https).send().await.is_err());
            assert!(fetch_with_retry(&https, 1, 0).await.is_err());
            // ...and plain http, which needs no certificate, still works.
            let http = http_client().unwrap().get(format!("http://{address}/")).send().await.unwrap();
            assert_eq!(http.status().as_u16(), 204);
        }
    }
}

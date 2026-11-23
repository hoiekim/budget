use std::future::Future;

use crate::server::alarm::send_alarm;
use crate::server::logger;
use crate::server::postgres::models::session::SessionData;

/// `true` for the shape the server issues (`randomUUID()`): hyphenated hex,
/// either case.
pub fn has_issued_sid_shape(sid: &str) -> bool {
    let bytes = sid.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// Reads one session row through `load`, degrading to `None` when there is none.
///
/// A sid without the issued shape is "no session" without touching the store,
/// so a garbage cookie never surfaces as a store fault. A store fault also
/// degrades to `None`, and is logged at error level and alarmed under the
/// `session_store_read_fault` key. The session id is never logged or alarmed:
/// it is a bearer-equivalent credential.
pub async fn read_session_data<F, Fut>(sid: &str, load: F) -> Option<SessionData>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = anyhow::Result<Option<SessionData>>>,
{
    if !has_issued_sid_shape(sid) {
        return None;
    }
    match load(sid.to_string()).await {
        Ok(data) => data,
        Err(error) => {
            logger::error("Session store read fault", Some(&crate::ctx! { "component": "sessions" }), Some(&error));
            let detail = format!("**Error:** {error}");
            tokio::spawn(async move {
                send_alarm("Session Store Read Fault", &detail, Some("session_store_read_fault"), false).await
            });
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use super::*;

    const SID: &str = "3f2b8c1e-9d4a-4e6f-8b2c-1a5d7e9f0b3c";

    #[test]
    fn only_a_hyphenated_hex_uuid_has_the_issued_shape() {
        assert!(has_issued_sid_shape(SID));
        assert!(has_issued_sid_shape(&SID.to_uppercase()));
        for sid in [
            "",
            "unknown",
            "3f2b8c1e9d4a4e6f8b2c1a5d7e9f0b3c",
            "{3f2b8c1e-9d4a-4e6f-8b2c-1a5d7e9f0b3c}",
            "3f2b8c1e-9d4a-4e6f-8b2c-1a5d7e9f0b3g",
            "3f2b8c1e-9d4a-4e6f-8b2c-1a5d7e9f0b3c0",
            "3f2b8c1e-9d4a-4e6f-8b2c-1a5d7e9f0b3\0",
        ] {
            assert!(!has_issued_sid_shape(sid), "{sid:?}");
        }
    }

    #[tokio::test]
    async fn a_sid_without_the_issued_shape_never_reaches_the_store() {
        let called = Arc::new(AtomicBool::new(false));
        let seen = called.clone();
        let result = read_session_data("nope", |_| async move {
            seen.store(true, Ordering::SeqCst);
            Ok(None)
        })
        .await;
        assert!(result.is_none());
        assert!(!called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_store_fault_reads_as_no_session() {
        let result = read_session_data(SID, |_| async { Err(anyhow::anyhow!("connection reset")) }).await;
        assert!(result.is_none());
    }
}

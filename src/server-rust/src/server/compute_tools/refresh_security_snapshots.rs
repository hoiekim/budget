//! `src/server/lib/compute-tools/refresh-security-snapshots.ts`. Not ported yet.

/// Refreshes the price snapshots of securities in use. Returns the counts the scheduler logs (`refreshed`, `fresh`, `cash`, `empty`, `errors`).
pub async fn refresh_active_security_snapshots() -> anyhow::Result<crate::js::Obj> {
    Ok(crate::js::Obj::new())
}

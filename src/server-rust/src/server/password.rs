//! Password hashing: bcrypt at cost 10 in the `$2b$` format, the hashes the
//! Bun backend stores. `src/server/lib/password.ts`.

/// Hashing is CPU-bound for tens of milliseconds, so it runs off the async threads.
pub async fn hash_password(password: &str) -> anyhow::Result<String> {
    let password = password.to_string();
    Ok(tokio::task::spawn_blocking(move || bcrypt::hash_with_result(password, 10).map(|parts| parts.format_for_version(bcrypt::Version::TwoB))).await??)
}

/// False for a hash that is not bcrypt, as for a wrong password.
pub async fn verify_password(password: &str, hash: &str) -> anyhow::Result<bool> {
    let (password, hash) = (password.to_string(), hash.to_string());
    Ok(tokio::task::spawn_blocking(move || bcrypt::verify(password, &hash).unwrap_or(false)).await?)
}

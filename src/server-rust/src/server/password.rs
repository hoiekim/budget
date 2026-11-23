//! Password hashing, compatible with what the Bun backend stores and
//! accepts (`src/server/lib/password.ts`, backed there by `Bun.password`):
//! new hashes are bcrypt at cost 10 in the `$2b$` format; verification also
//! reads argon2 hashes. As in Bun, a password longer than bcrypt's 72 bytes
//! is first reduced with SHA-512, so its tail still counts.

use argon2::{Argon2, PasswordHash, PasswordVerifier};
use sha2::{Digest, Sha512};

const BCRYPT_MAX_PASSWORD_BYTES: usize = 72;
const BCRYPT_HASH_LENGTH: usize = 60;

fn bcrypt_input(password: &str) -> Vec<u8> {
    if password.len() > BCRYPT_MAX_PASSWORD_BYTES {
        Sha512::digest(password.as_bytes()).to_vec()
    } else {
        password.as_bytes().to_vec()
    }
}

fn verify_blocking(password: &str, hash: &str) -> anyhow::Result<bool> {
    if hash.is_empty() {
        return Ok(false);
    }
    if hash.starts_with("$argon2") {
        let parsed = PasswordHash::new(hash).map_err(|_| anyhow::anyhow!("Password verification failed with error \"InvalidEncoding\""))?;
        return Ok(Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok());
    }
    if hash.starts_with("$2") {
        if hash.len() != BCRYPT_HASH_LENGTH {
            anyhow::bail!("Password verification failed with error \"InvalidEncoding\"");
        }
        return bcrypt::verify(bcrypt_input(password), hash).map_err(|error| match error {
            bcrypt::BcryptError::CostNotAllowed(_) => anyhow::anyhow!("Password verification failed with error \"WeakParameters\""),
            _ => anyhow::anyhow!("Password verification failed with error \"InvalidEncoding\""),
        });
    }
    anyhow::bail!("Password verification failed with error \"UnsupportedAlgorithm\"")
}

/// Hashing is CPU-bound for tens of milliseconds, so it runs off the async threads.
pub async fn hash_password(password: &str) -> anyhow::Result<String> {
    let input = bcrypt_input(password);
    Ok(tokio::task::spawn_blocking(move || bcrypt::hash_with_result(input, 10).map(|parts| parts.format_for_version(bcrypt::Version::TwoB)))
        .await??)
}

/// Whether `password` matches `hash`. An empty hash matches nothing; a hash
/// that is neither bcrypt nor argon2, or is malformed, is an error.
pub async fn verify_password(password: &str, hash: &str) -> anyhow::Result<bool> {
    let (password, hash) = (password.to_string(), hash.to_string());
    tokio::task::spawn_blocking(move || verify_blocking(&password, &hash)).await?
}

#[cfg(test)]
mod tests {
    use super::*;

    // Hashes of "pw" made by `Bun.password.hash`.
    const BUN_BCRYPT: &str = "$2b$04$kCCa.zhJpzNrI4zzy4i7BOwpE2K5m/Kxj0pvqFPa5MiYZ8K1pTzYu";

    #[test]
    fn refuses_what_bun_refuses() {
        assert!(!verify_blocking("pw", "").unwrap());
        assert!(verify_blocking("pw", "plaintext").is_err());
        assert!(verify_blocking("pw", "$2b$10$short").is_err());
        assert!(verify_blocking("pw", &format!("{BUN_BCRYPT}x")).is_err());
        assert!(verify_blocking("pw", &BUN_BCRYPT.replace("$04$", "$03$")).is_err());
    }

    #[test]
    fn long_passwords_count_past_72_bytes() {
        let long = "a".repeat(100);
        let hash = bcrypt::hash_with_result(bcrypt_input(&long), 4).unwrap().format_for_version(bcrypt::Version::TwoB);
        assert!(verify_blocking(&long, &hash).unwrap());
        assert!(!verify_blocking(&"a".repeat(99), &hash).unwrap());
        assert!(!verify_blocking(&"a".repeat(72), &hash).unwrap());
    }
}

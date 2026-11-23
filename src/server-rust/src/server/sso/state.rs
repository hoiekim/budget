//! The running single sign-on configuration: `src/server/lib/sso/state.ts`.

use std::sync::{Arc, RwLock};

use serde_json::json;

use super::config::{parse_sso_config, read_sso_env, SsoConfig, SsoConfigError};
use super::paths::{AUTH_CALLBACK_PATH, AUTH_EVENTS_PATH, AUTH_LOGIN_PATH};
use crate::js::Json;
use crate::server::auth_client::{AuthClient, AuthClientOptions};

pub struct Sso {
    pub config: SsoConfig,
    pub client: AuthClient,
}

/// How people sign in, as the sign-in page needs to know before anyone has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SsoMode {
    pub enabled: bool,
    /// The app's own password sign-in is offered.
    pub local_login: bool,
}

impl SsoMode {
    pub fn to_json(&self) -> Json {
        json!({ "enabled": self.enabled, "localLogin": self.local_login })
    }
}

static SSO: RwLock<Option<Arc<Sso>>> = RwLock::new(None);

/// `None` while single sign-on is off.
pub fn get_sso() -> Option<Arc<Sso>> {
    SSO.read().unwrap().clone()
}

/// Replaces the running configuration.
pub fn configure_sso(config: Option<SsoConfig>) -> anyhow::Result<()> {
    let sso = match config {
        Some(config) => {
            let client = AuthClient::new(AuthClientOptions {
                issuer: config.issuer.clone(),
                back_channel_url: config.back_channel_url.clone(),
                client_id: config.client_id.clone(),
                client_secret: Some(config.client_secret.clone()),
                redirect_uri: config.redirect_uri.clone(),
                audience: config.audience.clone(),
            })?;
            Some(Arc::new(Sso { config, client }))
        }
        None => None,
    };
    *SSO.write().unwrap() = sso;
    Ok(())
}

/// Reads the environment at boot; fails naming every problem.
pub fn initialize_sso() -> anyhow::Result<()> {
    let config = parse_sso_config(&read_sso_env()).map_err(|error: SsoConfigError| anyhow::Error::new(error))?;
    configure_sso(config)
}

pub fn sso_mode() -> SsoMode {
    match get_sso() {
        Some(sso) => SsoMode { enabled: true, local_login: sso.config.local_login },
        None => SsoMode { enabled: false, local_login: true },
    }
}

const SSO_PUBLIC_PATH_METHODS: [(&str, &str); 3] =
    [(AUTH_LOGIN_PATH, "GET"), (AUTH_CALLBACK_PATH, "GET"), (AUTH_EVENTS_PATH, "POST")];

/// The routes that answer anyone while single sign-on is on; while it is off there are none.
pub fn sso_public_path_methods() -> &'static [(&'static str, &'static str)] {
    if get_sso().is_some() {
        &SSO_PUBLIC_PATH_METHODS
    } else {
        &[]
    }
}

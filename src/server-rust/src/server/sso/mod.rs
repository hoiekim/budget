//! Optional single sign-on through an OpenID Connect identity provider:
//! `src/server/lib/sso/`.

pub mod config;
pub mod paths;
pub mod state;

pub use config::*;
pub use paths::*;
pub use state::*;

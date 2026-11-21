//! Optional single sign-on through an OpenID Connect identity provider:
//! `src/server/lib/sso/`.

pub mod config;
pub mod events;
pub mod http;
pub mod paths;
pub mod state;
pub mod users;

pub use config::*;
pub use paths::*;
pub use state::*;

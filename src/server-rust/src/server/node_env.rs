//! `src/server/lib/node-env.ts`.

pub fn node_env() -> Option<String> {
    std::env::var("NODE_ENV").ok()
}

pub fn is_production() -> bool {
    node_env().as_deref() == Some("production")
}

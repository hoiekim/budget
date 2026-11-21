//! The budget app's backend. See `lib.rs` for the layout.

#[tokio::main]
async fn main() {
    if let Err(error) = budget_server::start::run().await {
        budget_server::server::logger::error("The server could not start", None, Some(&error));
        std::process::exit(1);
    }
    std::process::exit(0);
}

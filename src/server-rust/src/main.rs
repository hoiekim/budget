//! The budget app's backend. See `lib.rs` for the layout.

// A response builds and drops a JSON map per row, so allocation is most of
// its cost; mimalloc does that several times faster than the system allocator
// and hands freed memory back to the system.
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    // Errors capture where they were raised, for the `stack` the log writes,
    // unless the environment already decides. Set before any other thread starts.
    if std::env::var_os("RUST_BACKTRACE").is_none() && std::env::var_os("RUST_LIB_BACKTRACE").is_none() {
        std::env::set_var("RUST_LIB_BACKTRACE", "1");
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("the async runtime can be built");
    if let Err(error) = runtime.block_on(budget_server::start::run()) {
        budget_server::server::logger::error("The server could not start", None, Some(&error));
        std::process::exit(1);
    }
    std::process::exit(0);
}

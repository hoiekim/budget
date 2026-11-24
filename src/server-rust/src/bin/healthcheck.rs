//! The Rust image's Docker health check: what `healthcheck.js` checks in the
//! Bun image, which has Bun to run it. The API answers, which takes the server
//! and its database, and the client is served, which takes the build output.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::ExitCode;
use std::time::Duration;

/// How long one connect, read or write may take. Docker gives the whole check 10 seconds.
const TIMEOUT: Duration = Duration::from_secs(4);

/// The most of a response read: its status line and headers.
const MAX_HEAD_BYTES: usize = 64 * 1024;

/// The status and `Content-Type` of the server's answer to `GET path`.
fn get(port: u16, path: &str) -> Result<(u16, String), String> {
    let mut stream = connect(port)?;
    stream.set_read_timeout(Some(TIMEOUT)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(TIMEOUT)).map_err(|e| e.to_string())?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;

    let mut head = Vec::new();
    let mut chunk = [0u8; 4096];
    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if read == 0 || head.len() + read > MAX_HEAD_BYTES {
            return Err(format!("{path} sent no complete response head"));
        }
        head.extend_from_slice(&chunk[..read]);
    }
    let head = String::from_utf8_lossy(&head);
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| format!("{path} sent no status"))?;
    let content_type = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| value.trim().to_string())
        .unwrap_or_default();
    Ok((status, content_type))
}

/// The first address `localhost` resolves to that takes the connection.
fn connect(port: u16) -> Result<TcpStream, String> {
    let mut last_error = format!("localhost:{port} resolved to no address");
    for address in ("localhost", port).to_socket_addrs().map_err(|e| e.to_string())? {
        match TcpStream::connect_timeout(&address, TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = format!("{address}: {error}"),
        }
    }
    Err(last_error)
}

/// Fails with what was wrong unless `path` answers 2xx, with `content_type` when one is named.
fn check(port: u16, path: &str, content_type: Option<&str>) -> Result<(), String> {
    let (status, received) = get(port, path)?;
    if !(200..300).contains(&status) {
        return Err(format!("{path} returned {status}"));
    }
    if let Some(expected) = content_type {
        if !received.contains(expected) {
            return Err(format!("{path} content-type was {received}"));
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    // Read as the server reads it.
    let port = std::env::var("PORT").ok().and_then(|port| port.parse().ok()).unwrap_or(3005);
    match check(port, "/api/health", None).and_then(|()| check(port, "/", Some("text/html"))) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("Healthcheck failed: {message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A server on a free port that answers each connection with the next of `responses`.
    fn serve(responses: &[&'static str]) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let responses = responses.to_vec();
        std::thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut chunk = [0u8; 1024];
                while !request.ends_with(b"\r\n\r\n") {
                    let read = stream.read(&mut chunk).unwrap();
                    assert!(read > 0, "the request ended before its head did");
                    request.extend_from_slice(&chunk[..read]);
                }
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        port
    }

    #[test]
    fn passes_on_a_2xx_with_the_content_type_named() {
        let port = serve(&[
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nContent-Type: text/html;charset=utf-8\r\n\r\n<html>",
        ]);
        assert_eq!(check(port, "/api/health", None), Ok(()));
        assert_eq!(check(port, "/", Some("text/html")), Ok(()));
    }

    #[test]
    fn fails_on_another_status_or_content_type() {
        let port = serve(&[
            "HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n",
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{}",
        ]);
        assert_eq!(check(port, "/api/health", None), Err("/api/health returned 503".to_string()));
        assert_eq!(check(port, "/", Some("text/html")), Err("/ content-type was application/json".to_string()));
    }

    #[test]
    fn fails_when_nothing_answers() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(check(port, "/api/health", None).is_err());
    }
}

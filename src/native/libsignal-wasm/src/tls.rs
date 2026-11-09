//! Pinned TLS client for Signal's servers, driven byte-by-byte from JS over KaiOS `TCPSocket`.
//!
//! Signal's services present certificates from Signal's own root, which Gecko doesn't trust. This client trusts only
//! the roots libsignal pins (`rust/net/res` in libsignal, copied into `res/`), so the phone's trust store is never
//! consulted and nothing outside `signal.org` can be reached through it.

use std::io::{ErrorKind, Read, Write};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use rustls::client::ClientConnection;
use rustls::time_provider::TimeProvider;
use rustls::{ClientConfig, RootCertStore};
use rustls_pki_types::{CertificateDer, ServerName, UnixTime};
use wasm_bindgen::prelude::*;

use crate::js_error;

/// libsignal's `SIGNAL_ROOT_CERTIFICATES`: the RSA root (through 2032) and the Ed25519 root (through 2036).
static SIGNAL_ROOTS: [&[u8]; 2] = [
    include_bytes!("../res/signal.cer"),
    include_bytes!("../res/signal-ed25519.cer"),
];

/// Upper bound on decrypted bytes held between `feed` and `read`, so a misbehaving peer can't exhaust memory.
const MAX_BUFFERED_PLAINTEXT: usize = 8 * 1024 * 1024;

#[derive(Debug)]
struct JsClock;

impl TimeProvider for JsClock {
    fn current_time(&self) -> Option<UnixTime> {
        let millis = js_sys::Date::now();
        if !millis.is_finite() || millis < 0.0 {
            return None;
        }
        Some(UnixTime::since_unix_epoch(Duration::from_millis(millis as u64)))
    }
}

fn tls_error(e: impl std::fmt::Display) -> JsValue {
    js_error("TlsError", e)
}

/// Built once so every connection shares rustls's in-memory session cache and resumes cheaply.
fn client_config() -> Result<Arc<ClientConfig>, JsValue> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    if let Some(config) = CONFIG.get() {
        return Ok(config.clone());
    }
    let mut roots = RootCertStore::empty();
    for der in SIGNAL_ROOTS {
        roots.add(CertificateDer::from(der)).map_err(tls_error)?;
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = ClientConfig::builder_with_details(provider, Arc::new(JsClock))
        .with_safe_default_protocol_versions()
        .map_err(tls_error)?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(CONFIG.get_or_init(|| Arc::new(config)).clone())
}

/// Accepts `signal.org` and its subdomains only.
pub(crate) fn is_signal_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "signal.org" || (host.ends_with(".signal.org") && !host.starts_with('.') && !host.contains(".."))
}

#[wasm_bindgen(js_name = isPinnedTlsHost)]
pub fn is_pinned_tls_host(host: &str) -> bool {
    is_signal_host(host)
}

#[wasm_bindgen]
pub struct TlsConn {
    conn: ClientConnection,
    plaintext: Vec<u8>,
    peer_closed: bool,
}

#[wasm_bindgen]
impl TlsConn {
    #[wasm_bindgen(constructor)]
    pub fn new(host: &str) -> Result<TlsConn, JsValue> {
        if !is_signal_host(host) {
            return Err(js_error("TlsHostNotAllowed", format!("{host} is not a Signal server")));
        }
        let name = ServerName::try_from(host.to_ascii_lowercase()).map_err(tls_error)?;
        let conn = ClientConnection::new(client_config()?, name).map_err(tls_error)?;
        Ok(TlsConn { conn, plaintext: Vec::new(), peer_closed: false })
    }

    /// Processes bytes received from the TCP socket. Certificate and protocol failures surface here as `TlsError`.
    pub fn feed(&mut self, data: &[u8]) -> Result<(), JsValue> {
        let mut rest = data;
        while !rest.is_empty() {
            let n = self.conn.read_tls(&mut rest).map_err(tls_error)?;
            let state = self.conn.process_new_packets().map_err(tls_error)?;
            self.drain_plaintext()?;
            if state.peer_has_closed() {
                self.peer_closed = true;
            }
            if n == 0 {
                break;
            }
        }
        Ok(())
    }

    /// TLS records to send on the TCP socket; call after `new`, `feed`, `write`, and `closeNotify`.
    #[wasm_bindgen(js_name = takeOutgoing)]
    pub fn take_outgoing(&mut self) -> Result<Vec<u8>, JsValue> {
        let mut out = Vec::new();
        while self.conn.wants_write() {
            self.conn.write_tls(&mut out).map_err(tls_error)?;
        }
        Ok(out)
    }

    /// Queues application data; rustls buffers it until the handshake completes.
    pub fn write(&mut self, data: &[u8]) -> Result<(), JsValue> {
        self.conn.writer().write_all(data).map_err(tls_error)
    }

    /// Decrypted application data received so far.
    pub fn read(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.plaintext)
    }

    #[wasm_bindgen(js_name = isHandshaking)]
    pub fn is_handshaking(&self) -> bool {
        self.conn.is_handshaking()
    }

    /// True once the server sent `close_notify`.
    #[wasm_bindgen(js_name = peerClosed)]
    pub fn peer_closed(&self) -> bool {
        self.peer_closed
    }

    #[wasm_bindgen(js_name = closeNotify)]
    pub fn close_notify(&mut self) {
        self.conn.send_close_notify();
    }

    fn drain_plaintext(&mut self) -> Result<(), JsValue> {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match self.conn.reader().read(&mut buf) {
                Ok(0) => {
                    self.peer_closed = true;
                    return Ok(());
                }
                Ok(n) => {
                    if self.plaintext.len() + n > MAX_BUFFERED_PLAINTEXT {
                        return Err(tls_error("too much unread data from server"));
                    }
                    self.plaintext.extend_from_slice(&buf[..n]);
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => return Ok(()),
                Err(e) => return Err(tls_error(e)),
            }
        }
    }
}

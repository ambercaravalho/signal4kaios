//! Contact discovery (CDSI): the attested Noise channel to Signal's SGX enclave, as libsignal's `Cds2ClientState`
//! (rust/bridge/shared/src/cds2.rs) exposes it to Signal-Desktop. `attest` verifies the enclave's DCAP quote with
//! BoringSSL before any phone number is sent; the request and response framing lives in TypeScript (engine/services/cdsi.ts).

use attest::client_connection::ClientConnection;
use attest::enclave::Handshake;
use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;

use crate::system_time;

/// Signal's production CDSI enclave, as libsignal-net's `ENDPOINT_PARAMS_CDSI_PROD`.
#[wasm_bindgen(js_name = cdsiMrenclave)]
pub fn cdsi_mrenclave() -> Uint8Array {
    Uint8Array::from(&attest::constants::ENCLAVE_ID_CDSI_PROD[..])
}

enum State {
    Handshaking(Handshake),
    Established(ClientConnection),
    Done,
}

#[wasm_bindgen]
pub struct Cds2Client {
    state: State,
}

#[wasm_bindgen]
impl Cds2Client {
    /// Verifies the enclave's attestation (the first WebSocket message) for `mrenclave` at `now_ms`, and starts the Noise handshake.
    #[wasm_bindgen(constructor)]
    pub fn new(mrenclave: &[u8], attestation_msg: &[u8], now_ms: f64) -> Result<Cds2Client, JsError> {
        let handshake = attest::cds2::new_handshake(mrenclave, attestation_msg, system_time(now_ms))
            .map_err(|e| JsError::new(&format!("CDSI attestation failed: {e}")))?;
        Ok(Cds2Client { state: State::Handshaking(handshake) })
    }

    /// The handshake message to send after the attestation.
    #[wasm_bindgen(js_name = initialRequest)]
    pub fn initial_request(&self) -> Result<Uint8Array, JsError> {
        match &self.state {
            State::Handshaking(h) => Ok(Uint8Array::from(h.initial_request())),
            _ => Err(JsError::new("CDSI handshake already completed")),
        }
    }

    /// Finishes the handshake with the enclave's reply.
    #[wasm_bindgen(js_name = completeHandshake)]
    pub fn complete_handshake(&mut self, reply: &[u8]) -> Result<(), JsError> {
        match std::mem::replace(&mut self.state, State::Done) {
            State::Handshaking(h) => {
                let conn = h.complete(reply).map_err(|e| JsError::new(&format!("CDSI handshake failed: {e}")))?;
                self.state = State::Established(conn);
                Ok(())
            }
            _ => Err(JsError::new("CDSI handshake not in progress")),
        }
    }

    /// Encrypts one request for the enclave.
    #[wasm_bindgen(js_name = establishedSend)]
    pub fn established_send(&mut self, plaintext: &[u8]) -> Result<Uint8Array, JsError> {
        match &mut self.state {
            State::Established(c) => c.send(plaintext).map(|v| Uint8Array::from(&v[..])).map_err(|e| JsError::new(&format!("{e}"))),
            _ => Err(JsError::new("CDSI channel not established")),
        }
    }

    /// Decrypts one response from the enclave.
    #[wasm_bindgen(js_name = establishedRecv)]
    pub fn established_recv(&mut self, ciphertext: &[u8]) -> Result<Uint8Array, JsError> {
        match &mut self.state {
            State::Established(c) => c.recv(ciphertext).map(|v| Uint8Array::from(&v[..])).map_err(|e| JsError::new(&format!("{e}"))),
            _ => Err(JsError::new("CDSI channel not established")),
        }
    }
}

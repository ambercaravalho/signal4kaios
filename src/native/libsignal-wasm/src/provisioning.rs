//! Linked-device provisioning cipher, via the official `libsignal-provisioning` crate.

use libsignal_provisioning::{ProvisioningError, RecvProvisionCiphertextState, encrypt_provision_message};
use wasm_bindgen::prelude::*;

use crate::{invalid, js_error, rng};

fn provisioning_error(e: ProvisioningError) -> JsValue {
    js_error("ProvisioningError", e)
}

/// Holds the ephemeral key pair the secondary device advertises in its `sgnl://linkdevice` QR code.
#[wasm_bindgen]
pub struct ProvisioningReceiver {
    state: RecvProvisionCiphertextState,
}

#[wasm_bindgen]
impl ProvisioningReceiver {
    #[wasm_bindgen(constructor)]
    pub fn new() -> ProvisioningReceiver {
        ProvisioningReceiver {
            state: RecvProvisionCiphertextState::generate(&mut rng()),
        }
    }

    /// 33-byte serialized public key for the `pub_key` QR parameter.
    #[wasm_bindgen(js_name = publicKey)]
    pub fn public_key(&self) -> Vec<u8> {
        self.state.public_key().to_vec()
    }

    /// Decrypts a serialized `ProvisionEnvelope` into the serialized `ProvisionMessage`.
    #[wasm_bindgen(js_name = decryptEnvelope)]
    pub fn decrypt_envelope(&self, envelope: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.state.decrypt_envelope(envelope).map_err(provisioning_error)
    }
}

impl Default for ProvisioningReceiver {
    fn default() -> Self {
        Self::new()
    }
}

/// Primary-device side of provisioning, used by tests to build envelopes for a receiver.
#[wasm_bindgen(js_name = provisioningEncrypt)]
pub fn provisioning_encrypt(secondary_public_key: &[u8], provision_message: &[u8]) -> Result<Vec<u8>, JsValue> {
    let key: [u8; 33] = secondary_public_key
        .try_into()
        .map_err(|_| invalid("secondary public key must be 33 bytes"))?;
    encrypt_provision_message(&mut rng(), &key, provision_message).map_err(provisioning_error)
}

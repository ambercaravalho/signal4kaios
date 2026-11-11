//! Sender Keys for group messages.

use libsignal_protocol::{
    SenderKeyDistributionMessage, SenderKeyMessage, create_sender_key_distribution_message,
    group_decrypt, group_encrypt, process_sender_key_distribution_message,
};
use uuid::Uuid;
use wasm_bindgen::prelude::*;

use crate::store::{ProtocolStore, address};
use crate::{invalid, parse, protocol_error, ready, rng};

fn distribution(id: &str) -> Result<Uuid, JsValue> {
    Uuid::parse_str(id).map_err(invalid)
}

/// Distribution ID a SenderKeyMessage was encrypted under, so TypeScript can load the matching record.
#[wasm_bindgen(js_name = senderKeyMessageDistributionId)]
pub fn sender_key_message_distribution_id(body: &[u8]) -> Result<String, JsValue> {
    let message = parse::<SenderKeyMessage>(body)?;
    Ok(message.distribution_id().to_string())
}

#[wasm_bindgen(js_name = senderKeyDistributionMessageDistributionId)]
pub fn sender_key_distribution_message_distribution_id(body: &[u8]) -> Result<String, JsValue> {
    let message = parse::<SenderKeyDistributionMessage>(body)?;
    Ok(message.distribution_id().map_err(protocol_error)?.to_string())
}

#[wasm_bindgen(js_name = processSenderKeyDistributionMessage)]
pub fn process_sender_key_distribution_message_js(
    store: &mut ProtocolStore,
    name: &str,
    device: u32,
    body: &[u8],
) -> Result<(), JsValue> {
    let message = parse::<SenderKeyDistributionMessage>(body)?;
    ready(process_sender_key_distribution_message(
        &address(name, device)?,
        &message,
        &mut store.sender_keys,
    ))
    .map_err(protocol_error)
}

#[wasm_bindgen(js_name = groupDecrypt)]
pub fn group_decrypt_js(
    store: &mut ProtocolStore,
    name: &str,
    device: u32,
    body: &[u8],
) -> Result<Vec<u8>, JsValue> {
    ready(group_decrypt(body, &mut store.sender_keys, &address(name, device)?)).map_err(protocol_error)
}

/// Creates (or reuses) our sender key chain for `distribution_id` and returns the serialized
/// SenderKeyDistributionMessage to hand to group members over 1:1 sessions.
#[wasm_bindgen(js_name = createSenderKeyDistributionMessage)]
pub fn create_sender_key_distribution_message_js(
    store: &mut ProtocolStore,
    local_name: &str,
    local_device: u32,
    distribution_id: &str,
) -> Result<Vec<u8>, JsValue> {
    let message = ready(create_sender_key_distribution_message(
        &address(local_name, local_device)?,
        distribution(distribution_id)?,
        &mut store.sender_keys,
        &mut rng(),
    ))
    .map_err(protocol_error)?;
    Ok(message.serialized().to_vec())
}

#[wasm_bindgen(js_name = groupEncrypt)]
pub fn group_encrypt_js(
    store: &mut ProtocolStore,
    local_name: &str,
    local_device: u32,
    distribution_id: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let message = ready(group_encrypt(
        &mut store.sender_keys,
        &address(local_name, local_device)?,
        distribution(distribution_id)?,
        plaintext,
        &mut rng(),
    ))
    .map_err(protocol_error)?;
    Ok(message.serialized().to_vec())
}

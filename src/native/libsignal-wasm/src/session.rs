//! 1:1 sessions: PQXDH session setup from a server PreKey bundle, Double/Triple Ratchet encrypt and decrypt, and the
//! DecryptionErrorMessage / PlaintextContent retry plumbing.

use libsignal_protocol::{
    CiphertextMessageType, DecryptionErrorMessage, IdentityKey, KyberPreKeyId,
    PlaintextContent, PreKeyBundle, PreKeyId, PreKeySignalMessage, PublicKey, SessionRecord,
    SignalMessage, SignedPreKeyId, Timestamp, kem, message_decrypt_prekey, message_decrypt_signal,
    message_encrypt, process_prekey_bundle,
};
use wasm_bindgen::prelude::*;

use crate::store::{ProtocolStore, address, device_id};
use crate::{Obj, invalid, protocol_error, ready, rng, system_time};

/// Builds a session with `name.device` from the fields of a `GET /v2/keys/{id}/{device}` response entry. Kyber fields
/// are mandatory: libsignal no longer establishes X3DH-only sessions.
#[wasm_bindgen(js_name = sessionProcessPreKeyBundle)]
#[allow(clippy::too_many_arguments)]
pub fn session_process_pre_key_bundle(
    store: &mut ProtocolStore,
    local_name: &str,
    local_device: u32,
    name: &str,
    device: u32,
    registration_id: u32,
    pre_key_id: Option<u32>,
    pre_key_public: Option<Vec<u8>>,
    signed_pre_key_id: u32,
    signed_pre_key_public: &[u8],
    signed_pre_key_signature: &[u8],
    kyber_pre_key_id: u32,
    kyber_pre_key_public: &[u8],
    kyber_pre_key_signature: &[u8],
    identity_key: &[u8],
    now_millis: f64,
) -> Result<(), JsValue> {
    let pre_key = match (pre_key_id, pre_key_public) {
        (Some(id), Some(public)) => Some((
            PreKeyId::from(id),
            PublicKey::deserialize(&public).map_err(|e| invalid(e))?,
        )),
        _ => None,
    };
    let bundle = PreKeyBundle::new(
        registration_id,
        device_id(device)?,
        pre_key,
        SignedPreKeyId::from(signed_pre_key_id),
        PublicKey::deserialize(signed_pre_key_public).map_err(|e| invalid(e))?,
        signed_pre_key_signature.to_vec(),
        KyberPreKeyId::from(kyber_pre_key_id),
        kem::PublicKey::deserialize(kyber_pre_key_public).map_err(protocol_error)?,
        kyber_pre_key_signature.to_vec(),
        IdentityKey::decode(identity_key).map_err(protocol_error)?,
    )
    .map_err(protocol_error)?;

    ready(process_prekey_bundle(
        &address(name, device)?,
        &address(local_name, local_device)?,
        &mut store.sessions,
        &mut store.identities,
        &bundle,
        system_time(now_millis),
        &mut rng(),
    ))
    .map_err(protocol_error)
}

/// Encrypts a padded `Content` for `name.device`: `{ type, body }`, where `type` is the libsignal
/// `CiphertextMessageType` (2 = Whisper, 3 = PreKey).
#[wasm_bindgen(js_name = sessionEncrypt)]
pub fn session_encrypt(
    store: &mut ProtocolStore,
    local_name: &str,
    local_device: u32,
    name: &str,
    device: u32,
    plaintext: &[u8],
    now_millis: f64,
) -> Result<JsValue, JsValue> {
    let message = ready(message_encrypt(
        plaintext,
        &address(name, device)?,
        &address(local_name, local_device)?,
        &mut store.sessions,
        &mut store.identities,
        system_time(now_millis),
        &mut rng(),
    ))
    .map_err(protocol_error)?;
    Ok(Obj::new()
        .set("type", message.message_type() as u8)
        .bytes("body", message.serialize())
        .build())
}

#[wasm_bindgen(js_name = sessionDecryptSignal)]
pub fn session_decrypt_signal(
    store: &mut ProtocolStore,
    local_name: &str,
    local_device: u32,
    name: &str,
    device: u32,
    body: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let message = SignalMessage::try_from(body).map_err(protocol_error)?;
    ready(message_decrypt_signal(
        &message,
        &address(name, device)?,
        &address(local_name, local_device)?,
        &mut store.sessions,
        &mut store.identities,
        &mut rng(),
    ))
    .map_err(protocol_error)
}

#[wasm_bindgen(js_name = sessionDecryptPreKey)]
pub fn session_decrypt_pre_key(
    store: &mut ProtocolStore,
    local_name: &str,
    local_device: u32,
    name: &str,
    device: u32,
    body: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let message = PreKeySignalMessage::try_from(body).map_err(protocol_error)?;
    let result = ready(message_decrypt_prekey(
        &message,
        &address(name, device)?,
        &address(local_name, local_device)?,
        &mut store.sessions,
        &mut store.identities,
        &mut store.pre_keys,
        &store.signed_pre_keys,
        &mut store.kyber_pre_keys,
        &mut rng(),
    ))
    .map_err(protocol_error)?;
    Ok(result.plaintext)
}

/// The PreKey IDs a `PreKeySignalMessage` references, so TypeScript can load just those records before decrypting:
/// `{ preKeyId?, signedPreKeyId, kyberPreKeyId? }`.
#[wasm_bindgen(js_name = preKeyMessageIds)]
pub fn pre_key_message_ids(body: &[u8]) -> Result<JsValue, JsValue> {
    let message = PreKeySignalMessage::try_from(body).map_err(protocol_error)?;
    let mut out = Obj::new().set("signedPreKeyId", u32::from(message.signed_pre_key_id()));
    if let Some(id) = message.pre_key_id() {
        out = out.set("preKeyId", u32::from(id));
    }
    if let Some(id) = message.kyber_pre_key_id() {
        out = out.set("kyberPreKeyId", u32::from(id));
    }
    Ok(out.build())
}

/// Remote registration ID of the current session state, needed for `destinationRegistrationId` on sends.
#[wasm_bindgen(js_name = sessionRecordRemoteRegistrationId)]
pub fn session_record_remote_registration_id(record: &[u8]) -> Result<u32, JsValue> {
    let record = SessionRecord::deserialize(record).map_err(protocol_error)?;
    record.remote_registration_id().map_err(protocol_error)
}

/// Whether the record has a current session state that can still send (not archived or stale).
#[wasm_bindgen(js_name = sessionRecordHasCurrentState)]
pub fn session_record_has_current_state(record: &[u8], now_millis: f64) -> Result<bool, JsValue> {
    let record = SessionRecord::deserialize(record).map_err(protocol_error)?;
    record
        .has_usable_sender_chain(
            system_time(now_millis),
            libsignal_protocol::SessionUsabilityRequirements::NotStale,
        )
        .map_err(protocol_error)
}

/// Archives the current session state (used on END_SESSION and after a peer's DecryptionErrorMessage).
#[wasm_bindgen(js_name = sessionRecordArchiveCurrentState)]
pub fn session_record_archive_current_state(record: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut record = SessionRecord::deserialize(record).map_err(protocol_error)?;
    record.archive_current_state().map_err(protocol_error)?;
    record.serialize().map_err(protocol_error)
}

fn ciphertext_type(value: u8) -> Result<CiphertextMessageType, JsValue> {
    match value {
        2 => Ok(CiphertextMessageType::Whisper),
        3 => Ok(CiphertextMessageType::PreKey),
        7 => Ok(CiphertextMessageType::SenderKey),
        8 => Ok(CiphertextMessageType::Plaintext),
        other => Err(invalid(format!("unknown ciphertext type {other}"))),
    }
}

/// Serialized `PlaintextContent` wrapping a `DecryptionErrorMessage` for a ciphertext we failed to decrypt. Send it with
/// envelope type PLAINTEXT_CONTENT (8).
#[wasm_bindgen(js_name = decryptionErrorPlaintextContent)]
pub fn decryption_error_plaintext_content(
    original_bytes: &[u8],
    original_type: u8,
    original_timestamp: f64,
    original_sender_device_id: u32,
) -> Result<Vec<u8>, JsValue> {
    let message = DecryptionErrorMessage::for_original(
        original_bytes,
        ciphertext_type(original_type)?,
        Timestamp::from_epoch_millis(original_timestamp.max(0.0) as u64),
        original_sender_device_id,
    )
    .map_err(protocol_error)?;
    Ok(PlaintextContent::from(message).serialized().to_vec())
}

/// The padded `Content` bytes carried by a serialized `PlaintextContent` (envelope type PLAINTEXT_CONTENT).
#[wasm_bindgen(js_name = plaintextContentBody)]
pub fn plaintext_content_body(serialized: &[u8]) -> Result<Vec<u8>, JsValue> {
    let content = PlaintextContent::try_from(serialized).map_err(protocol_error)?;
    Ok(content.body().to_vec())
}

/// Parses a serialized `DecryptionErrorMessage`: `{ timestamp, deviceId, ratchetKey? }`.
#[wasm_bindgen(js_name = decryptionErrorMessageParse)]
pub fn decryption_error_message_parse(serialized: &[u8]) -> Result<JsValue, JsValue> {
    let message = DecryptionErrorMessage::try_from(serialized).map_err(protocol_error)?;
    Ok(Obj::new()
        .set("timestamp", message.timestamp().epoch_millis() as f64)
        .set("deviceId", message.device_id())
        .opt_bytes("ratchetKey", message.ratchet_key().map(|k| k.serialize()).as_deref())
        .build())
}
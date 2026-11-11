//! Sealed Sender v1: outbound encryption with our server-issued SenderCertificate, and inbound unsealing with
//! SenderCertificate validation against Signal's published trust roots.

use libsignal_protocol::{
    CiphertextMessageType, ContentHint, ProtocolAddress, PublicKey, SenderCertificate, ServiceId, SessionRecord,
    Timestamp, UnidentifiedSenderMessageContent, sealed_sender_decrypt_to_usmc, sealed_sender_encrypt,
    sealed_sender_multi_recipient_encrypt,
};
use wasm_bindgen::prelude::*;

use crate::store::{ProtocolStore, address, device_u32};
use crate::keys::public_key;
use crate::{Obj, invalid, js_error, parse, protocol_error, ready, rng, system_time};

/// Seals one SenderKeyMessage for many devices at once, for `PUT /v1/messages/multi_recipient`. `names[i]`/`devices[i]`
/// is each recipient device; every one needs a session in the store. `group_id` (empty for none) and `content_hint` go
/// into the sealed content as in Signal-Desktop's sendToGroup.
#[wasm_bindgen(js_name = sealedSenderMultiRecipientEncrypt)]
pub fn sealed_sender_multi_recipient_encrypt_js(
    store: &mut ProtocolStore,
    names: js_sys::Array,
    devices: &[u32],
    sender_certificate: &[u8],
    sender_key_message: &[u8],
    content_hint: u32,
    group_id: &[u8],
) -> Result<Vec<u8>, JsValue> {
    if names.length() as usize != devices.len() || devices.is_empty() {
        return Err(invalid("names and devices must be the same non-empty length"));
    }
    let certificate = parse::<SenderCertificate>(sender_certificate)?;
    let usmc = UnidentifiedSenderMessageContent::new(
        CiphertextMessageType::SenderKey,
        certificate,
        sender_key_message.to_vec(),
        ContentHint::from(content_hint),
        if group_id.is_empty() { None } else { Some(group_id.to_vec()) },
    )
    .map_err(protocol_error)?;
    let mut addresses: Vec<ProtocolAddress> = Vec::with_capacity(devices.len());
    for (name, device) in names.iter().zip(devices) {
        let name = name.as_string().ok_or_else(|| invalid("names must be strings"))?;
        addresses.push(address(&name, *device)?);
    }
    let mut sessions: Vec<SessionRecord> = Vec::with_capacity(addresses.len());
    for a in &addresses {
        let record = store
            .sessions
            .records
            .get(&(a.name().to_owned(), device_u32(a.device_id())))
            .ok_or_else(|| js_error("SessionNotFound", format!("no session for {a}")))?;
        sessions.push(record.clone());
    }
    let address_refs: Vec<&ProtocolAddress> = addresses.iter().collect();
    let session_refs: Vec<&SessionRecord> = sessions.iter().collect();
    ready(sealed_sender_multi_recipient_encrypt(
        &address_refs,
        &session_refs,
        Vec::<ServiceId>::new(),
        &usmc,
        &store.identities,
        &mut rng(),
    ))
    .map_err(protocol_error)
}

/// Seals an already padded `Content` for `name.device` using the existing session. The inner message type (PreKey or
/// Whisper) is chosen by libsignal from the session state.
#[wasm_bindgen(js_name = sealedSenderEncrypt)]
pub fn sealed_sender_encrypt_js(
    store: &mut ProtocolStore,
    name: &str,
    device: u32,
    sender_certificate: &[u8],
    plaintext: &[u8],
    now_millis: f64,
) -> Result<Vec<u8>, JsValue> {
    let certificate = parse::<SenderCertificate>(sender_certificate)?;
    ready(sealed_sender_encrypt(
        &address(name, device)?,
        &certificate,
        plaintext,
        &mut store.sessions,
        &mut store.identities,
        system_time(now_millis),
        &mut rng(),
    ))
    .map_err(protocol_error)
}

fn trust_roots(concatenated: &[u8]) -> Result<Vec<PublicKey>, JsValue> {
    if concatenated.is_empty() || concatenated.len() % 33 != 0 {
        return Err(invalid("trust roots must be one or more 33-byte public keys"));
    }
    concatenated
        .chunks(33)
        .map(public_key)
        .collect()
}

/// Unwraps the outer Sealed Sender layer with our identity key and validates the sender's certificate. Returns
/// `{ messageType, senderUuid, senderE164?, senderDeviceId, contents, contentHint, groupId? }`; `contents` is the inner
/// ciphertext to decrypt with the session APIs according to `messageType`.
#[wasm_bindgen(js_name = sealedSenderDecryptToUsmc)]
pub fn sealed_sender_decrypt_to_usmc_js(
    store: &mut ProtocolStore,
    ciphertext: &[u8],
    trust_roots_concatenated: &[u8],
    now_millis: f64,
) -> Result<JsValue, JsValue> {
    let roots = trust_roots(trust_roots_concatenated)?;
    let usmc = ready(sealed_sender_decrypt_to_usmc(ciphertext, &store.identities)).map_err(protocol_error)?;
    let sender = usmc.sender().map_err(protocol_error)?;
    let valid = sender
        .validate_with_trust_roots(&roots, Timestamp::from_epoch_millis(now_millis.max(0.0) as u64))
        .map_err(protocol_error)?;
    if !valid {
        return Err(js_error("InvalidSenderCertificate", "sender certificate failed validation"));
    }
    Ok(Obj::new()
        .set("messageType", usmc.msg_type().map_err(protocol_error)? as u8)
        .set("senderUuid", sender.sender_uuid().map_err(protocol_error)?)
        .set(
            "senderE164",
            match sender.sender_e164().map_err(protocol_error)? {
                Some(e164) => JsValue::from_str(e164),
                None => JsValue::UNDEFINED,
            },
        )
        .set("senderDeviceId", device_u32(sender.sender_device_id().map_err(protocol_error)?))
        .bytes("contents", usmc.contents().map_err(protocol_error)?)
        .set("contentHint", u32::from(usmc.content_hint().map_err(protocol_error)?))
        .opt_bytes("groupId", usmc.group_id().map_err(protocol_error)?)
        .build())
}

/// `{ senderUuid, senderE164?, senderDeviceId, expiration }` for a serialized SenderCertificate, used to cache our own
/// certificate until shortly before it expires.
#[wasm_bindgen(js_name = senderCertificateInfo)]
pub fn sender_certificate_info(serialized: &[u8]) -> Result<JsValue, JsValue> {
    let cert = parse::<SenderCertificate>(serialized)?;
    Ok(Obj::new()
        .set("senderUuid", cert.sender_uuid().map_err(protocol_error)?)
        .set(
            "senderE164",
            match cert.sender_e164().map_err(protocol_error)? {
                Some(e164) => JsValue::from_str(e164),
                None => JsValue::UNDEFINED,
            },
        )
        .set("senderDeviceId", device_u32(cert.sender_device_id().map_err(protocol_error)?))
        .set("expiration", cert.expiration().map_err(protocol_error)?.epoch_millis() as f64)
        .build())
}

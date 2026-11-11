//! Curve25519 key handling and PreKey record generation.

use libsignal_protocol::{
    GenericSignedPreKey, IdentityKeyPair, KeyPair, KyberPreKeyId, KyberPreKeyRecord, PreKeyId, PreKeyRecord,
    PrivateKey, PublicKey, SignedPreKeyId, SignedPreKeyRecord, Timestamp, kem,
};
use rand::Rng;
use wasm_bindgen::prelude::*;

use crate::{Obj, invalid, parse, protocol_error, rng};

pub(crate) fn private_key(bytes: &[u8]) -> Result<PrivateKey, JsValue> {
    PrivateKey::deserialize(bytes).map_err(invalid)
}

pub(crate) fn public_key(bytes: &[u8]) -> Result<PublicKey, JsValue> {
    PublicKey::deserialize(bytes).map_err(invalid)
}

/// Generates an X25519 key pair: `{ publicKey (33 bytes), privateKey (32 bytes) }`.
#[wasm_bindgen(js_name = keyPairGenerate)]
pub fn key_pair_generate() -> JsValue {
    let pair = KeyPair::generate(&mut rng());
    Obj::new()
        .bytes("publicKey", &pair.public_key.serialize())
        .bytes("privateKey", &pair.private_key.serialize())
        .build()
}

#[wasm_bindgen(js_name = calculateAgreement)]
pub fn calculate_agreement(their_public: &[u8], our_private: &[u8]) -> Result<Vec<u8>, JsValue> {
    let shared = private_key(our_private)?
        .calculate_agreement(&public_key(their_public)?)
        .map_err(invalid)?;
    Ok(shared.into_vec())
}

/// Registration IDs are 14-bit values in `1..=16383`, as Signal clients generate them.
#[wasm_bindgen(js_name = generateRegistrationId)]
pub fn generate_registration_id() -> u32 {
    rng().random_range(1..=16383)
}

/// `{ record, publicKey }` for a one-time EC PreKey.
#[wasm_bindgen(js_name = preKeyRecordGenerate)]
pub fn pre_key_record_generate(id: u32) -> Result<JsValue, JsValue> {
    let pair = KeyPair::generate(&mut rng());
    let record = PreKeyRecord::new(PreKeyId::from(id), &pair);
    Ok(Obj::new()
        .bytes("record", &record.serialize().map_err(protocol_error)?)
        .bytes("publicKey", &pair.public_key.serialize())
        .build())
}

/// `{ record, publicKey, signature }` for a signed EC PreKey, signed with the identity private key.
#[wasm_bindgen(js_name = signedPreKeyRecordGenerate)]
pub fn signed_pre_key_record_generate(
    id: u32,
    timestamp_millis: f64,
    identity_private: &[u8],
) -> Result<JsValue, JsValue> {
    let identity = private_key(identity_private)?;
    let pair = KeyPair::generate(&mut rng());
    let signature = identity
        .calculate_signature(&pair.public_key.serialize(), &mut rng())
        .map_err(invalid)?;
    let record = SignedPreKeyRecord::new(
        SignedPreKeyId::from(id),
        Timestamp::from_epoch_millis(timestamp_millis.max(0.0) as u64),
        &pair,
        &signature,
    );
    Ok(Obj::new()
        .bytes("record", &record.serialize().map_err(protocol_error)?)
        .bytes("publicKey", &pair.public_key.serialize())
        .bytes("signature", &signature)
        .build())
}

/// `{ record, publicKey, signature }` for a signed Kyber1024 PreKey (wire key type 0x08, as deployed by Signal).
///
/// Built by hand rather than via `KyberPreKeyRecord::generate`, which reads `SystemTime::now()` (unavailable on
/// wasm32-unknown-unknown).
#[wasm_bindgen(js_name = kyberPreKeyRecordGenerate)]
pub fn kyber_pre_key_record_generate(
    id: u32,
    timestamp_millis: f64,
    identity_private: &[u8],
) -> Result<JsValue, JsValue> {
    let identity = private_key(identity_private)?;
    let pair = kem::KeyPair::generate(kem::KeyType::Kyber1024, &mut rng());
    let public = pair.public_key.serialize();
    let signature = identity
        .calculate_signature(&public, &mut rng())
        .map_err(invalid)?;
    let record = KyberPreKeyRecord::new(
        KyberPreKeyId::from(id),
        Timestamp::from_epoch_millis(timestamp_millis.max(0.0) as u64),
        &pair,
        &signature,
    );
    Ok(Obj::new()
        .bytes("record", &record.serialize().map_err(protocol_error)?)
        .bytes("publicKey", &public)
        .bytes("signature", &signature)
        .build())
}

/// `{ publicKey (33 bytes), privateKey (32 bytes) }` from a serialized `IdentityKeyPair`, as the primary device sends in
/// `SyncMessage.PniChangeNumber`.
#[wasm_bindgen(js_name = identityKeyPairDeserialize)]
pub fn identity_key_pair_deserialize(serialized: &[u8]) -> Result<JsValue, JsValue> {
    let pair = parse::<IdentityKeyPair>(serialized)?;
    Ok(Obj::new()
        .bytes("publicKey", &pair.identity_key().serialize())
        .bytes("privateKey", &pair.private_key().serialize())
        .build())
}

/// The ID of a serialized `SignedPreKeyRecord`, which must parse.
#[wasm_bindgen(js_name = signedPreKeyRecordId)]
pub fn signed_pre_key_record_id(record: &[u8]) -> Result<u32, JsValue> {
    let record = parse::<SignedPreKeyRecord>(record)?;
    Ok(u32::from(record.id().map_err(protocol_error)?))
}

/// The ID of a serialized `KyberPreKeyRecord`, which must parse.
#[wasm_bindgen(js_name = kyberPreKeyRecordId)]
pub fn kyber_pre_key_record_id(record: &[u8]) -> Result<u32, JsValue> {
    let record = parse::<KyberPreKeyRecord>(record)?;
    Ok(u32::from(record.id().map_err(protocol_error)?))
}

/// KEM encapsulation against a serialized (type-prefixed) public key: `{ ciphertext, sharedSecret }`. Test helper for the
/// interop suite.
#[wasm_bindgen(js_name = kemEncapsulate)]
pub fn kem_encapsulate(public: &[u8]) -> Result<JsValue, JsValue> {
    let key = parse::<kem::PublicKey>(public)?;
    let (shared, ciphertext) = key.encapsulate(&mut rng()).map_err(invalid)?;
    Ok(Obj::new()
        .bytes("ciphertext", &ciphertext)
        .bytes("sharedSecret", &shared)
        .build())
}

/// Decapsulates with the secret key held by a serialized `KyberPreKeyRecord`. Test helper for the interop suite.
#[wasm_bindgen(js_name = kyberPreKeyRecordDecapsulate)]
pub fn kyber_pre_key_record_decapsulate(record: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, JsValue> {
    let record = parse::<KyberPreKeyRecord>(record)?;
    let secret = record.secret_key().map_err(protocol_error)?;
    let shared = secret
        .decapsulate(&ciphertext.to_vec().into_boxed_slice())
        .map_err(invalid)?;
    Ok(shared.into_vec())
}

//! zkgroup: profile keys and Groups V2 (group secret params, blob and member decryption, auth credential
//! presentations for `storage.signal.org`).

use libsignal_protocol::{Aci, Pni, ServiceId};
use uuid::Uuid;
use wasm_bindgen::prelude::*;
use zkgroup::auth::AuthCredentialWithPniResponse;
use zkgroup::groups::{GroupMasterKey, GroupSecretParams, ProfileKeyCiphertext, UuidCiphertext};
use zkgroup::profiles::ProfileKey;
use zkgroup::{ServerPublicParams, Timestamp};

use crate::{Obj, invalid, js_error, random_32};

fn verification_failed() -> JsValue {
    js_error("ZkGroupVerificationFailure", "zkgroup verification failed")
}

fn aci(uuid: &str) -> Result<Aci, JsValue> {
    Ok(Aci::from(Uuid::parse_str(uuid).map_err(|e| invalid(e))?))
}

fn pni(uuid: &str) -> Result<Pni, JsValue> {
    let raw = uuid.strip_prefix("PNI:").unwrap_or(uuid);
    Ok(Pni::from(Uuid::parse_str(raw).map_err(|e| invalid(e))?))
}

fn profile_key(bytes: &[u8]) -> Result<ProfileKey, JsValue> {
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| invalid("profile key must be 32 bytes"))?;
    Ok(ProfileKey::create(bytes))
}

fn secret_params(serialized: &[u8]) -> Result<GroupSecretParams, JsValue> {
    zkgroup::deserialize(serialized).map_err(|e| invalid(e))
}

/// 64-character hex profile key version for `GET /v1/profile/{aci}/{version}`.
#[wasm_bindgen(js_name = profileKeyGetVersion)]
pub fn profile_key_get_version(profile_key_bytes: &[u8], aci_uuid: &str) -> Result<String, JsValue> {
    let version = profile_key(profile_key_bytes)?.get_profile_key_version(aci(aci_uuid)?);
    String::from_utf8(zkgroup::serialize(&version)).map_err(|e| invalid(e))
}

/// Serialized ProfileKeyCommitment for `PUT /v1/profile`.
#[wasm_bindgen(js_name = profileKeyGetCommitment)]
pub fn profile_key_get_commitment(profile_key_bytes: &[u8], aci_uuid: &str) -> Result<Vec<u8>, JsValue> {
    let commitment = profile_key(profile_key_bytes)?.get_commitment(aci(aci_uuid)?);
    Ok(zkgroup::serialize(&commitment))
}

/// 16-byte Unidentified-Access-Key derived from a profile key.
#[wasm_bindgen(js_name = profileKeyDeriveAccessKey)]
pub fn profile_key_derive_access_key(profile_key_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    Ok(profile_key(profile_key_bytes)?.derive_access_key().to_vec())
}

/// `{ secretParams, publicParams, groupIdentifier }` derived from a 32-byte Groups V2 master key.
#[wasm_bindgen(js_name = groupSecretParamsFromMasterKey)]
pub fn group_secret_params_from_master_key(master_key: &[u8]) -> Result<JsValue, JsValue> {
    let bytes: [u8; 32] = master_key.try_into().map_err(|_| invalid("group master key must be 32 bytes"))?;
    let params = GroupSecretParams::derive_from_master_key(GroupMasterKey::new(bytes));
    Ok(Obj::new()
        .bytes("secretParams", &zkgroup::serialize(&params))
        .bytes("publicParams", &zkgroup::serialize(&params.get_public_params()))
        .bytes("groupIdentifier", &params.get_group_identifier())
        .build())
}

/// Decrypts a padded group attribute blob (title, description, disappearing-messages timer).
#[wasm_bindgen(js_name = groupDecryptBlob)]
pub fn group_decrypt_blob(secret_params_bytes: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, JsValue> {
    secret_params(secret_params_bytes)?
        .decrypt_blob_with_padding(ciphertext)
        .map_err(|_| verification_failed())
}

#[wasm_bindgen(js_name = groupEncryptBlob)]
pub fn group_encrypt_blob(
    secret_params_bytes: &[u8],
    plaintext: &[u8],
    padding_len: u32,
) -> Result<Vec<u8>, JsValue> {
    Ok(secret_params(secret_params_bytes)?.encrypt_blob_with_padding(random_32(), plaintext, padding_len))
}

/// Decrypts a member's encrypted service ID, returning the service ID string (`uuid` for ACIs, `PNI:uuid` for PNIs).
#[wasm_bindgen(js_name = groupDecryptServiceId)]
pub fn group_decrypt_service_id(secret_params_bytes: &[u8], ciphertext: &[u8]) -> Result<String, JsValue> {
    let ciphertext: UuidCiphertext = zkgroup::deserialize(ciphertext).map_err(|e| invalid(e))?;
    let service_id = secret_params(secret_params_bytes)?
        .decrypt_service_id(ciphertext)
        .map_err(|_| verification_failed())?;
    Ok(service_id.service_id_string())
}

#[wasm_bindgen(js_name = groupEncryptServiceId)]
pub fn group_encrypt_service_id(secret_params_bytes: &[u8], service_id: &str) -> Result<Vec<u8>, JsValue> {
    let service_id =
        ServiceId::parse_from_service_id_string(service_id).ok_or_else(|| invalid("invalid service id"))?;
    let ciphertext = secret_params(secret_params_bytes)?.encrypt_service_id(service_id);
    Ok(zkgroup::serialize(&ciphertext))
}

/// Decrypts a member's encrypted 32-byte profile key.
#[wasm_bindgen(js_name = groupDecryptProfileKey)]
pub fn group_decrypt_profile_key(
    secret_params_bytes: &[u8],
    ciphertext: &[u8],
    aci_uuid: &str,
) -> Result<Vec<u8>, JsValue> {
    let ciphertext: ProfileKeyCiphertext = zkgroup::deserialize(ciphertext).map_err(|e| invalid(e))?;
    let key = secret_params(secret_params_bytes)?
        .decrypt_profile_key(ciphertext, aci(aci_uuid)?)
        .map_err(|_| verification_failed())?;
    Ok(key.get_bytes().to_vec())
}

/// Receives an `AuthCredentialWithPniResponse` from `GET /v1/certificate/auth/group` and presents it for one group.
/// The result is the `authCredentialPresentation` half of the Basic auth used against `storage.signal.org/v2/groups`.
#[wasm_bindgen(js_name = groupAuthCredentialPresentation)]
pub fn group_auth_credential_presentation(
    server_public_params: &[u8],
    aci_uuid: &str,
    pni_uuid: &str,
    redemption_time_seconds: f64,
    credential_response: &[u8],
    secret_params_bytes: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let server_params: ServerPublicParams = zkgroup::deserialize(server_public_params).map_err(|e| invalid(e))?;
    let response = AuthCredentialWithPniResponse::new(credential_response).map_err(|e| invalid(e))?;
    let credential = response
        .receive(
            &server_params,
            aci(aci_uuid)?,
            pni(pni_uuid)?,
            Timestamp::from_epoch_seconds(redemption_time_seconds.max(0.0) as u64),
        )
        .map_err(|_| verification_failed())?;
    let presentation = credential.present(&server_params, &secret_params(secret_params_bytes)?, random_32());
    Ok(zkgroup::serialize(&presentation))
}

//! Usernames: candidate generation, hashes, zero-knowledge proofs, and encrypted username links (libsignal `usernames`).

use usernames::{NicknameLimits, Username, UsernameError, UsernameLinkError};
use wasm_bindgen::prelude::*;

use crate::{Obj, array, invalid, js_error, random_32, rng};

/// `UsernameError` whose message is the libsignal variant (`NicknameTooShort`, `BadNicknameCharacter`, ...).
pub(crate) fn username_error(e: UsernameError) -> JsValue {
    js_error("UsernameError", format!("{e:?}"))
}

fn link_error(e: UsernameLinkError) -> JsValue {
    js_error("UsernameLinkError", format!("{e:?}"))
}

/// Candidate `nickname.discriminator` usernames for `PUT /v1/accounts/username_hash/reserve`, using Signal's default
/// nickname limits (3 to 32 characters).
#[wasm_bindgen(js_name = usernameCandidates)]
pub fn username_candidates(nickname: &str) -> Result<js_sys::Array, JsValue> {
    let candidates =
        Username::candidates_from(&mut rng(), nickname, NicknameLimits::default()).map_err(username_error)?;
    Ok(array(candidates.into_iter().map(JsValue::from)))
}

/// Zero-knowledge proof that the caller knows the username behind its hash, for `PUT /v1/accounts/username_hash/confirm`.
#[wasm_bindgen(js_name = usernameProof)]
pub fn username_proof(username: &str) -> Result<Vec<u8>, JsValue> {
    Username::new(username).map_err(username_error)?.proof(&random_32()).map_err(username_error)
}

/// `{ entropy, encryptedUsername }` for a username link. Pass the current 32-byte entropy to keep the link key, or
/// nothing to generate a new one.
#[wasm_bindgen(js_name = usernameLinkCreate)]
pub fn username_link_create(username: &str, entropy: Option<Vec<u8>>) -> Result<JsValue, JsValue> {
    let entropy: Option<[u8; 32]> = match entropy {
        Some(e) => Some(e.as_slice().try_into().map_err(|_| invalid("username link entropy must be 32 bytes"))?),
        None => None,
    };
    let (entropy, encrypted) =
        usernames::create_for_username(&mut rng(), username.to_owned(), entropy.as_ref()).map_err(link_error)?;
    Ok(Obj::new().bytes("entropy", &entropy).bytes("encryptedUsername", &encrypted).build())
}

/// Decrypts the username stored behind a username link.
#[wasm_bindgen(js_name = usernameLinkDecrypt)]
pub fn username_link_decrypt(entropy: &[u8], encrypted_username: &[u8]) -> Result<String, JsValue> {
    let entropy: [u8; 32] = entropy.try_into().map_err(|_| invalid("username link entropy must be 32 bytes"))?;
    usernames::decrypt_username(&entropy, encrypted_username).map_err(link_error)
}

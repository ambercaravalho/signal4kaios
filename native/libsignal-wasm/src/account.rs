//! Account-wide key derivations: Account Entropy Pool and username hashing.

use std::str::FromStr;

use libsignal_account_keys::AccountEntropyPool;
use wasm_bindgen::prelude::*;

use crate::{invalid, js_error};

/// Derives the 32-byte master key (SVR key) from the Account Entropy Pool string sent in `ProvisionMessage`. Storage
/// Service keys are derived from this value.
#[wasm_bindgen(js_name = accountEntropyPoolDeriveMasterKey)]
pub fn account_entropy_pool_derive_master_key(account_entropy_pool: &str) -> Result<Vec<u8>, JsValue> {
    let pool = AccountEntropyPool::from_str(account_entropy_pool).map_err(|e| invalid(format!("{e:?}")))?;
    Ok(pool.derive_svr_key().to_vec())
}

/// 32-byte username hash for `GET /v1/accounts/username_hash/{hash}` (URL-safe base64, no padding). Throws
/// `UsernameError` for usernames that do not parse as `nickname.discriminator`.
#[wasm_bindgen(js_name = usernameHash)]
pub fn username_hash(username: &str) -> Result<Vec<u8>, JsValue> {
    let parsed = usernames::Username::new(username).map_err(|e| js_error("UsernameError", e))?;
    Ok(parsed.hash().to_vec())
}

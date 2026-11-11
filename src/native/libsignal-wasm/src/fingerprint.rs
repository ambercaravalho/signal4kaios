//! Safety numbers (displayable and scannable fingerprints).

use libsignal_protocol::{Fingerprint, IdentityKey, ScannableFingerprint};
use wasm_bindgen::prelude::*;

use crate::{Obj, invalid, parse};

/// `{ displayable (60 digits), scannable (protobuf bytes for the QR code) }`. Signal clients use version 2 with 16-byte
/// ACI UUIDs as identifiers and 5200 iterations.
#[wasm_bindgen(js_name = fingerprintCreate)]
pub fn fingerprint_create(
    version: u32,
    iterations: u32,
    local_id: &[u8],
    local_key: &[u8],
    remote_id: &[u8],
    remote_key: &[u8],
) -> Result<JsValue, JsValue> {
    let local_key = parse::<IdentityKey>(local_key)?;
    let remote_key = parse::<IdentityKey>(remote_key)?;
    let fingerprint = Fingerprint::new(version, iterations, local_id, &local_key, remote_id, &remote_key)
        .map_err(invalid)?;
    Ok(Obj::new()
        .set("displayable", fingerprint.display_string().map_err(invalid)?)
        .bytes("scannable", &fingerprint.scannable.serialize().map_err(invalid)?)
        .build())
}

/// Compares our scannable fingerprint with one scanned from the other person's QR code.
#[wasm_bindgen(js_name = fingerprintCompare)]
pub fn fingerprint_compare(ours_scannable: &[u8], scanned: &[u8]) -> Result<bool, JsValue> {
    let ours = ScannableFingerprint::deserialize(ours_scannable).map_err(invalid)?;
    ours.compare(scanned).map_err(invalid)
}

//! wasm-bindgen surface over Signal's official libsignal crates for signal4kaios.
//!
//! The API is record-in, record-out: TypeScript hydrates a [`store::ProtocolStore`] with the serialized libsignal records an
//! operation needs, calls one of the exported functions, then persists whatever the store reports as changed. Every
//! libsignal store future resolves immediately against the in-memory maps, so all exports are synchronous.

use std::time::{Duration, SystemTime};

use futures_util::FutureExt;
use js_sys::{Array, Object, Reflect, Uint8Array};
use libsignal_protocol::{
    DecryptionErrorMessage, GenericSignedPreKey, IdentityKey, IdentityKeyPair, KyberPreKeyRecord, PlaintextContent,
    PreKeyRecord, PreKeySignalMessage, SenderCertificate, SenderKeyDistributionMessage, SenderKeyMessage,
    SenderKeyRecord, SessionRecord, SignalMessage, SignalProtocolError, SignedPreKeyRecord, kem,
};
use rand::TryRngCore;
use wasm_bindgen::prelude::*;

mod account;
mod backup;
mod cdsi;
mod fingerprint;
mod group;
mod keys;
mod provisioning;
mod sealed;
mod session;
mod store;
mod tls;
mod username;
mod zk;

pub const LIBSIGNAL_VERSION: &str = "0.106.2";

#[wasm_bindgen(js_name = libsignalVersion)]
pub fn libsignal_version() -> String {
    LIBSIGNAL_VERSION.to_owned()
}

pub(crate) fn rng() -> rand::rand_core::UnwrapErr<rand::rngs::OsRng> {
    rand::rngs::OsRng.unwrap_err()
}

pub(crate) fn random_32() -> [u8; 32] {
    let mut out = [0u8; 32];
    rand::rngs::OsRng
        .try_fill_bytes(&mut out)
        .expect("crypto.getRandomValues is available");
    out
}

pub(crate) fn system_time(epoch_millis: f64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_millis(epoch_millis.max(0.0) as u64)
}

/// Every libsignal store call in this crate is backed by in-memory maps, so the future is always ready.
pub(crate) fn ready<T>(fut: impl std::future::Future<Output = T>) -> T {
    fut.now_or_never()
        .expect("in-memory libsignal store futures resolve synchronously")
}

/// Builds a JS `Error` whose `name` is a stable code TypeScript can branch on.
pub(crate) fn js_error(code: &str, message: impl std::fmt::Display) -> JsValue {
    let err = js_sys::Error::new(&message.to_string());
    err.set_name(code);
    err.into()
}

pub(crate) fn protocol_error(e: SignalProtocolError) -> JsValue {
    let code = match &e {
        SignalProtocolError::UntrustedIdentity(_) => "UntrustedIdentity",
        SignalProtocolError::SessionNotFound(_) => "SessionNotFound",
        SignalProtocolError::InvalidPreKeyId => "InvalidPreKeyId",
        SignalProtocolError::InvalidSignedPreKeyId => "InvalidSignedPreKeyId",
        SignalProtocolError::InvalidKyberPreKeyId => "InvalidKyberPreKeyId",
        SignalProtocolError::DuplicatedMessage(_, _) => "DuplicatedMessage",
        SignalProtocolError::NoSenderKeyState { .. } => "NoSenderKeyState",
        SignalProtocolError::InvalidSealedSenderMessage(_) => "InvalidSealedSenderMessage",
        SignalProtocolError::UnknownSealedSenderVersion(_) => "InvalidSealedSenderMessage",
        SignalProtocolError::SealedSenderSelfSend => "SealedSenderSelfSend",
        SignalProtocolError::InvalidMessage(_, _) => "InvalidMessage",
        SignalProtocolError::LegacyCiphertextVersion(_) => "LegacyCiphertextVersion",
        SignalProtocolError::UnrecognizedCiphertextVersion(_) => "UnrecognizedCiphertextVersion",
        SignalProtocolError::InvalidProtobufEncoding => "InvalidProtobufEncoding",
        SignalProtocolError::SignatureValidationFailed => "SignatureValidationFailed",
        _ => "SignalProtocolError",
    };
    js_error(code, e)
}

pub(crate) fn invalid(message: impl std::fmt::Display) -> JsValue {
    js_error("InvalidArgument", message)
}

/// A libsignal record, key, or message that TypeScript passes in serialized.
pub(crate) trait FromBytes: Sized {
    fn from_bytes(bytes: &[u8]) -> Result<Self, SignalProtocolError>;
}

macro_rules! from_bytes {
    ($via:ident: $($t:ty),+) => {
        $(impl FromBytes for $t {
            fn from_bytes(bytes: &[u8]) -> Result<Self, SignalProtocolError> {
                <$t>::$via(bytes)
            }
        })+
    };
}

from_bytes!(deserialize:
    SessionRecord, PreKeyRecord, SignedPreKeyRecord, KyberPreKeyRecord, SenderKeyRecord, SenderCertificate, kem::PublicKey
);
from_bytes!(decode: IdentityKey);
from_bytes!(try_from:
    SignalMessage, PreKeySignalMessage, PlaintextContent, DecryptionErrorMessage, SenderKeyMessage,
    SenderKeyDistributionMessage, IdentityKeyPair
);

/// Parses a serialized libsignal value, failing with the stable error code TypeScript branches on.
pub(crate) fn parse<T: FromBytes>(bytes: &[u8]) -> Result<T, JsValue> {
    T::from_bytes(bytes).map_err(protocol_error)
}

/// Small builder for plain JS result objects.
pub(crate) struct Obj(Object);

impl Obj {
    pub(crate) fn new() -> Self {
        Obj(Object::new())
    }

    pub(crate) fn set(self, key: &str, value: impl Into<JsValue>) -> Self {
        Reflect::set(&self.0, &JsValue::from_str(key), &value.into())
            .expect("setting a property on a fresh object cannot fail");
        self
    }

    pub(crate) fn bytes(self, key: &str, value: &[u8]) -> Self {
        self.set(key, Uint8Array::from(value))
    }

    pub(crate) fn opt_bytes(self, key: &str, value: Option<&[u8]>) -> Self {
        match value {
            Some(v) => self.bytes(key, v),
            None => self,
        }
    }

    pub(crate) fn build(self) -> JsValue {
        self.0.into()
    }
}

pub(crate) fn array(items: impl IntoIterator<Item = JsValue>) -> Array {
    items.into_iter().collect()
}

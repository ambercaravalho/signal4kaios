//! Per-operation in-memory libsignal stores that record what changed so TypeScript can persist it.

use std::collections::{BTreeSet, HashMap};

use async_trait::async_trait;
use libsignal_protocol::{
    DeviceId, Direction, IdentityChange, IdentityKey, IdentityKeyPair,
    IdentityKeyStore, KyberPreKeyId, KyberPreKeyRecord, KyberPreKeyStore, PreKeyId, PreKeyRecord,
    PreKeyStore, ProtocolAddress, PublicKey, SenderKeyRecord, SenderKeyStore,
    SessionRecord, SessionStore, SignalProtocolError, SignedPreKeyId, SignedPreKeyRecord,
    SignedPreKeyStore,
};
use uuid::Uuid;
use wasm_bindgen::prelude::*;

use crate::keys::{private_key, public_key};
use crate::{Obj, array, invalid, parse, protocol_error};

type Result<T> = std::result::Result<T, SignalProtocolError>;

pub(crate) fn device_id(id: u32) -> std::result::Result<DeviceId, JsValue> {
    DeviceId::try_from(id).map_err(|_| invalid(format!("invalid device id {id}")))
}

pub(crate) fn address(name: &str, device: u32) -> std::result::Result<ProtocolAddress, JsValue> {
    Ok(ProtocolAddress::new(name.to_owned(), device_id(device)?))
}

pub(crate) fn device_u32(id: DeviceId) -> u32 {
    u32::from(u8::from(id))
}

#[derive(Default)]
pub(crate) struct Identities {
    pub(crate) key_pair: Option<IdentityKeyPair>,
    pub(crate) registration_id: u32,
    pub(crate) known: HashMap<String, IdentityKey>,
    pub(crate) saved: Vec<(String, IdentityKey, bool)>,
}

#[async_trait(?Send)]
impl IdentityKeyStore for Identities {
    async fn get_identity_key_pair(&self) -> Result<IdentityKeyPair> {
        self.key_pair
            .ok_or_else(|| SignalProtocolError::InvalidState("identity", "no local identity key pair".into()))
    }

    async fn get_local_registration_id(&self) -> Result<u32> {
        Ok(self.registration_id)
    }

    async fn save_identity(
        &mut self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
    ) -> Result<IdentityChange> {
        let name = address.name().to_owned();
        let replaced = matches!(self.known.get(&name), Some(existing) if existing != identity);
        let unchanged = matches!(self.known.get(&name), Some(existing) if existing == identity);
        self.known.insert(name.clone(), *identity);
        if !unchanged {
            self.saved.push((name, *identity, replaced));
        }
        Ok(IdentityChange::from_changed(replaced))
    }

    async fn is_trusted_identity(
        &self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
        direction: Direction,
    ) -> Result<bool> {
        // Incoming messages are always accepted (the new key is saved and surfaced as a safety-number change). Outgoing
        // sends require the key to match the one TypeScript approved and loaded into this store.
        Ok(match direction {
            Direction::Receiving => true,
            Direction::Sending => match self.known.get(address.name()) {
                None => true,
                Some(existing) => existing == identity,
            },
        })
    }

    async fn get_identity(&self, address: &ProtocolAddress) -> Result<Option<IdentityKey>> {
        Ok(self.known.get(address.name()).copied())
    }
}

#[derive(Default)]
pub(crate) struct Sessions {
    pub(crate) records: HashMap<(String, u32), SessionRecord>,
    pub(crate) changed: BTreeSet<(String, u32)>,
}

#[async_trait(?Send)]
impl SessionStore for Sessions {
    async fn load_session(&self, address: &ProtocolAddress) -> Result<Option<SessionRecord>> {
        Ok(self
            .records
            .get(&(address.name().to_owned(), device_u32(address.device_id())))
            .cloned())
    }

    async fn store_session(&mut self, address: &ProtocolAddress, record: &SessionRecord) -> Result<()> {
        let key = (address.name().to_owned(), device_u32(address.device_id()));
        self.records.insert(key.clone(), record.clone());
        self.changed.insert(key);
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct PreKeys {
    pub(crate) records: HashMap<u32, PreKeyRecord>,
    pub(crate) removed: Vec<u32>,
}

#[async_trait(?Send)]
impl PreKeyStore for PreKeys {
    async fn get_pre_key(&self, id: PreKeyId) -> Result<PreKeyRecord> {
        self.records
            .get(&u32::from(id))
            .cloned()
            .ok_or(SignalProtocolError::InvalidPreKeyId)
    }

    async fn save_pre_key(&mut self, id: PreKeyId, record: &PreKeyRecord) -> Result<()> {
        self.records.insert(u32::from(id), record.clone());
        Ok(())
    }

    async fn remove_pre_key(&mut self, id: PreKeyId) -> Result<()> {
        self.records.remove(&u32::from(id));
        self.removed.push(u32::from(id));
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct SignedPreKeys {
    pub(crate) records: HashMap<u32, SignedPreKeyRecord>,
}

#[async_trait(?Send)]
impl SignedPreKeyStore for SignedPreKeys {
    async fn get_signed_pre_key(&self, id: SignedPreKeyId) -> Result<SignedPreKeyRecord> {
        self.records
            .get(&u32::from(id))
            .cloned()
            .ok_or(SignalProtocolError::InvalidSignedPreKeyId)
    }

    async fn save_signed_pre_key(&mut self, id: SignedPreKeyId, record: &SignedPreKeyRecord) -> Result<()> {
        self.records.insert(u32::from(id), record.clone());
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct KyberPreKeys {
    pub(crate) records: HashMap<u32, KyberPreKeyRecord>,
    pub(crate) used: Vec<u32>,
}

#[async_trait(?Send)]
impl KyberPreKeyStore for KyberPreKeys {
    async fn get_kyber_pre_key(&self, id: KyberPreKeyId) -> Result<KyberPreKeyRecord> {
        self.records
            .get(&u32::from(id))
            .cloned()
            .ok_or(SignalProtocolError::InvalidKyberPreKeyId)
    }

    async fn save_kyber_pre_key(&mut self, id: KyberPreKeyId, record: &KyberPreKeyRecord) -> Result<()> {
        self.records.insert(u32::from(id), record.clone());
        Ok(())
    }

    async fn mark_kyber_pre_key_used(
        &mut self,
        id: KyberPreKeyId,
        _ec_prekey_id: SignedPreKeyId,
        _base_key: &PublicKey,
    ) -> Result<()> {
        self.used.push(u32::from(id));
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct SenderKeys {
    pub(crate) records: HashMap<(String, u32, Uuid), SenderKeyRecord>,
    pub(crate) changed: BTreeSet<(String, u32, Uuid)>,
}

#[async_trait(?Send)]
impl SenderKeyStore for SenderKeys {
    async fn store_sender_key(
        &mut self,
        sender: &ProtocolAddress,
        distribution_id: Uuid,
        record: &SenderKeyRecord,
    ) -> Result<()> {
        let key = (sender.name().to_owned(), device_u32(sender.device_id()), distribution_id);
        self.records.insert(key.clone(), record.clone());
        self.changed.insert(key);
        Ok(())
    }

    async fn load_sender_key(
        &mut self,
        sender: &ProtocolAddress,
        distribution_id: Uuid,
    ) -> Result<Option<SenderKeyRecord>> {
        Ok(self
            .records
            .get(&(sender.name().to_owned(), device_u32(sender.device_id()), distribution_id))
            .cloned())
    }
}

/// A snapshot of exactly the protocol state one operation needs, plus a log of what that operation changed.
#[wasm_bindgen]
pub struct ProtocolStore {
    pub(crate) identities: Identities,
    pub(crate) sessions: Sessions,
    pub(crate) pre_keys: PreKeys,
    pub(crate) signed_pre_keys: SignedPreKeys,
    pub(crate) kyber_pre_keys: KyberPreKeys,
    pub(crate) sender_keys: SenderKeys,
}

#[wasm_bindgen]
impl ProtocolStore {
    /// `identity_public` is the 33-byte serialized public key, `identity_private` the 32-byte private scalar.
    #[wasm_bindgen(constructor)]
    pub fn new(
        identity_public: &[u8],
        identity_private: &[u8],
        registration_id: u32,
    ) -> std::result::Result<ProtocolStore, JsValue> {
        let public = public_key(identity_public)?;
        let private = private_key(identity_private)?;
        Ok(ProtocolStore {
            identities: Identities {
                key_pair: Some(IdentityKeyPair::new(IdentityKey::new(public), private)),
                registration_id,
                ..Default::default()
            },
            sessions: Sessions::default(),
            pre_keys: PreKeys::default(),
            signed_pre_keys: SignedPreKeys::default(),
            kyber_pre_keys: KyberPreKeys::default(),
            sender_keys: SenderKeys::default(),
        })
    }

    #[wasm_bindgen(js_name = putIdentity)]
    pub fn put_identity(&mut self, name: &str, public_key: &[u8]) -> std::result::Result<(), JsValue> {
        let key = parse::<IdentityKey>(public_key)?;
        self.identities.known.insert(name.to_owned(), key);
        Ok(())
    }

    #[wasm_bindgen(js_name = putSession)]
    pub fn put_session(&mut self, name: &str, device: u32, record: &[u8]) -> std::result::Result<(), JsValue> {
        let record = parse::<SessionRecord>(record)?;
        self.sessions.records.insert((name.to_owned(), device), record);
        Ok(())
    }

    #[wasm_bindgen(js_name = putPreKey)]
    pub fn put_pre_key(&mut self, id: u32, record: &[u8]) -> std::result::Result<(), JsValue> {
        let record = parse::<PreKeyRecord>(record)?;
        self.pre_keys.records.insert(id, record);
        Ok(())
    }

    #[wasm_bindgen(js_name = putSignedPreKey)]
    pub fn put_signed_pre_key(&mut self, id: u32, record: &[u8]) -> std::result::Result<(), JsValue> {
        let record = parse::<SignedPreKeyRecord>(record)?;
        self.signed_pre_keys.records.insert(id, record);
        Ok(())
    }

    #[wasm_bindgen(js_name = putKyberPreKey)]
    pub fn put_kyber_pre_key(&mut self, id: u32, record: &[u8]) -> std::result::Result<(), JsValue> {
        let record = parse::<KyberPreKeyRecord>(record)?;
        self.kyber_pre_keys.records.insert(id, record);
        Ok(())
    }

    #[wasm_bindgen(js_name = putSenderKey)]
    pub fn put_sender_key(
        &mut self,
        name: &str,
        device: u32,
        distribution_id: &str,
        record: &[u8],
    ) -> std::result::Result<(), JsValue> {
        let dist = Uuid::parse_str(distribution_id).map_err(invalid)?;
        let record = parse::<SenderKeyRecord>(record)?;
        self.sender_keys.records.insert((name.to_owned(), device, dist), record);
        Ok(())
    }

    /// Sessions written by the last operations: `[{ name, deviceId, record }]`.
    #[wasm_bindgen(js_name = takeChangedSessions)]
    pub fn take_changed_sessions(&mut self) -> std::result::Result<js_sys::Array, JsValue> {
        let changed = std::mem::take(&mut self.sessions.changed);
        let mut out = Vec::with_capacity(changed.len());
        for key in changed {
            let record = self.sessions.records.get(&key).expect("changed session is present");
            let bytes = record.serialize().map_err(protocol_error)?;
            out.push(
                Obj::new()
                    .set("name", key.0.as_str())
                    .set("deviceId", key.1)
                    .bytes("record", &bytes)
                    .build(),
            );
        }
        Ok(array(out))
    }

    /// Identities saved by the last operations: `[{ name, publicKey, replaced }]`.
    #[wasm_bindgen(js_name = takeSavedIdentities)]
    pub fn take_saved_identities(&mut self) -> js_sys::Array {
        let saved = std::mem::take(&mut self.identities.saved);
        array(saved.into_iter().map(|(name, key, replaced)| {
            Obj::new()
                .set("name", name.as_str())
                .bytes("publicKey", &key.serialize())
                .set("replaced", replaced)
                .build()
        }))
    }

    #[wasm_bindgen(js_name = takeRemovedPreKeys)]
    pub fn take_removed_pre_keys(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.pre_keys.removed)
    }

    #[wasm_bindgen(js_name = takeUsedKyberPreKeys)]
    pub fn take_used_kyber_pre_keys(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.kyber_pre_keys.used)
    }

    /// Sender keys written by the last operations: `[{ name, deviceId, distributionId, record }]`.
    #[wasm_bindgen(js_name = takeChangedSenderKeys)]
    pub fn take_changed_sender_keys(&mut self) -> std::result::Result<js_sys::Array, JsValue> {
        let changed = std::mem::take(&mut self.sender_keys.changed);
        let mut out = Vec::with_capacity(changed.len());
        for key in changed {
            let record = self.sender_keys.records.get(&key).expect("changed sender key is present");
            let bytes = record.serialize().map_err(protocol_error)?;
            out.push(
                Obj::new()
                    .set("name", key.0.as_str())
                    .set("deviceId", key.1)
                    .set("distributionId", key.2.to_string())
                    .bytes("record", &bytes)
                    .build(),
            );
        }
        Ok(array(out))
    }
}

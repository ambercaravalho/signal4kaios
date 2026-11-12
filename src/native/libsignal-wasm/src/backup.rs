//! Link-and-sync transfer archives, read like Signal-Desktop's `importBackup` for `link-and-sync`: libsignal's message
//! backup key, then HMAC-SHA256 over `iv || ciphertext`, AES-256-CBC, gunzip, and varint-delimited `Frame`s. The archive
//! arrives in chunks from IndexedDB, so the reader is pushed bytes instead of pulling them like libsignal's `FramesReader`.

use std::io::Write;

use aes::Aes256;
use cbc::cipher::{Block, BlockModeDecrypt, KeyIvInit};
use flate2::write::GzDecoder;
use hmac::{Hmac, KeyInit, Mac};
use js_sys::{Array, Uint8Array};
use libsignal_account_keys::BackupKey;
use libsignal_message_backup::key::MessageBackupKey;
use libsignal_protocol::Aci;
use sha2::Sha256;
use subtle::ConstantTimeEq;
use uuid::Uuid;
use wasm_bindgen::prelude::*;

use crate::{Obj, invalid, js_error};

const MAC_LEN: usize = 32;
const BLOCK: usize = 16;
const MAX_FRAME_LEN: usize = 8 << 20;
const FORWARD_SECRECY_MAGIC: &[u8] = b"SBACKUP\x01";

fn derive(backup_key: &[u8], aci: &str) -> Result<MessageBackupKey, JsValue> {
    let key: [u8; 32] = backup_key.try_into().map_err(|_| invalid("backup key must be 32 bytes"))?;
    let key: BackupKey = BackupKey(key);
    let aci = Aci::from(Uuid::parse_str(aci).map_err(invalid)?);
    Ok(MessageBackupKey::derive(&key, &key.derive_backup_id(&aci), None))
}

fn corrupt(message: impl std::fmt::Display) -> JsValue {
    js_error("BackupCorrupt", message)
}

/// SECURITY-REVIEW: the HMAC and AES keys for a link-and-sync archive (no forward secrecy token, as in Signal-Desktop).
#[wasm_bindgen(js_name = messageBackupKey)]
pub fn message_backup_key(backup_key: &[u8], aci: &str) -> Result<JsValue, JsValue> {
    let k = derive(backup_key, aci)?;
    Ok(Obj::new().bytes("hmacKey", &k.hmac_key).bytes("aesKey", &k.aes_key).build())
}

/// Reads one archive front to back. With `decrypt` false it only checks the HMAC (Signal-Desktop's first pass); with
/// `decrypt` true `push` returns the complete frames so far and `finish` checks the HMAC again.
#[wasm_bindgen]
pub struct BackupReader {
    mac: Hmac<Sha256>,
    aes_key: [u8; 32],
    decrypt: bool,
    checked_magic: bool,
    held: Vec<u8>,
    cbc: Option<cbc::Decryptor<Aes256>>,
    gz: GzDecoder<Vec<u8>>,
    gz_done: bool,
    plain: Vec<u8>,
}

#[wasm_bindgen]
impl BackupReader {
    #[wasm_bindgen(constructor)]
    pub fn new(backup_key: &[u8], aci: &str, decrypt: bool) -> Result<BackupReader, JsValue> {
        let k = derive(backup_key, aci)?;
        Ok(BackupReader {
            mac: <Hmac<Sha256> as KeyInit>::new_from_slice(&k.hmac_key).map_err(invalid)?,
            aes_key: k.aes_key,
            decrypt,
            checked_magic: false,
            held: Vec::new(),
            cbc: None,
            gz: GzDecoder::new(Vec::new()),
            gz_done: false,
            plain: Vec::new(),
        })
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Array, JsValue> {
        self.held.extend_from_slice(chunk);
        if !self.checked_magic {
            if self.held.len() < FORWARD_SECRECY_MAGIC.len() {
                return Ok(Array::new());
            }
            if self.held.starts_with(FORWARD_SECRECY_MAGIC) {
                return Err(js_error("BackupUnsupported", "archive uses the forward secrecy format"));
            }
            self.checked_magic = true;
        }
        let reserve = MAC_LEN + if self.decrypt { BLOCK } else { 0 };
        if self.held.len() <= reserve {
            return Ok(Array::new());
        }
        let mut n = self.held.len() - reserve;
        if self.decrypt {
            n -= n % BLOCK;
        }
        let ready: Vec<u8> = self.held.drain(..n).collect();
        self.consume(&ready)?;
        self.take_frames()
    }

    pub fn finish(&mut self) -> Result<Array, JsValue> {
        let min = MAC_LEN + if self.decrypt { BLOCK } else { 0 };
        if self.held.len() < min {
            return Err(corrupt("archive is truncated"));
        }
        let theirs = self.held.split_off(self.held.len() - MAC_LEN);
        let rest = std::mem::take(&mut self.held);
        if self.decrypt {
            if rest.len() % BLOCK != 0 {
                return Err(corrupt("ciphertext is not block aligned"));
            }
            let (body, last) = rest.split_at(rest.len() - BLOCK);
            self.consume(body)?;
            self.mac.update(last);
            let mut block = Block::<Aes256>::try_from(last).map_err(corrupt)?;
            self.cbc.as_mut().ok_or_else(|| corrupt("archive is truncated"))?.decrypt_block(&mut block);
            let pad = block[BLOCK - 1] as usize;
            if pad == 0 || pad > BLOCK || block[BLOCK - pad..].iter().any(|&b| b as usize != pad) {
                return Err(corrupt("bad padding"));
            }
            let tail = block[..BLOCK - pad].to_vec();
            self.inflate(&tail)?;
            self.gz.try_finish().map_err(corrupt)?;
            self.plain.extend_from_slice(self.gz.get_ref());
            self.gz.get_mut().clear();
        } else {
            self.mac.update(&rest);
        }
        let ours = self.mac.clone().finalize().into_bytes();
        if !bool::from(ours.as_slice().ct_eq(&theirs)) {
            return Err(js_error("BackupBadMac", "archive HMAC doesn't match"));
        }
        let frames = self.take_frames()?;
        if !self.plain.is_empty() {
            return Err(corrupt("archive ends inside a frame"));
        }
        Ok(frames)
    }
}

impl BackupReader {
    fn consume(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        self.mac.update(bytes);
        if !self.decrypt {
            return Ok(());
        }
        let mut out = Vec::with_capacity(bytes.len());
        for chunk in bytes.chunks_exact(BLOCK) {
            match self.cbc.as_mut() {
                None => {
                    let iv: [u8; BLOCK] = chunk.try_into().expect("exact chunk");
                    self.cbc = Some(cbc::Decryptor::<Aes256>::new(&self.aes_key.into(), &iv.into()));
                }
                Some(cbc) => {
                    let mut block = Block::<Aes256>::try_from(chunk).map_err(corrupt)?;
                    cbc.decrypt_block(&mut block);
                    out.extend_from_slice(&block);
                }
            }
        }
        self.inflate(&out)
    }

    fn inflate(&mut self, mut data: &[u8]) -> Result<(), JsValue> {
        while !data.is_empty() && !self.gz_done {
            let n = self.gz.write(data).map_err(corrupt)?;
            if n == 0 {
                self.gz_done = true;
            }
            data = &data[n..];
        }
        if !self.gz_done {
            self.gz.flush().map_err(corrupt)?;
        }
        self.plain.extend_from_slice(self.gz.get_ref());
        self.gz.get_mut().clear();
        Ok(())
    }

    fn take_frames(&mut self) -> Result<Array, JsValue> {
        let frames = Array::new();
        let mut pos = 0;
        loop {
            let Some((len, header)) = read_varint(&self.plain[pos..])? else { break };
            if len > MAX_FRAME_LEN {
                return Err(corrupt("frame is too large"));
            }
            let start = pos + header;
            if self.plain.len() - start < len {
                break;
            }
            frames.push(&Uint8Array::from(&self.plain[start..start + len]));
            pos = start + len;
        }
        self.plain.drain(..pos);
        Ok(frames)
    }
}

/// A protobuf varint length prefix and how many bytes it took, or `None` when more bytes are needed.
fn read_varint(buf: &[u8]) -> Result<Option<(usize, usize)>, JsValue> {
    let mut value: u64 = 0;
    for (i, &b) in buf.iter().enumerate().take(10) {
        value |= u64::from(b & 0x7f) << (7 * i);
        if b & 0x80 == 0 {
            return Ok(Some((usize::try_from(value).map_err(corrupt)?, i + 1)));
        }
    }
    if buf.len() >= 10 {
        return Err(corrupt("bad frame length"));
    }
    Ok(None)
}

//! 1:1 voice call media: RingRTC's SRTP key agreement, SRTP with AEAD_AES_256_GCM (RFC 7714), and Opus.
//!
//! RingRTC disables DTLS and keys SRTP from an X25519 exchange carried in the offer and answer (RingRTC
//! `src/rust/src/core/connection.rs` `negotiate_srtp_keys`); the offerer sends with the offer key and the answerer with
//! the answer key. Libsrtp then derives session keys from those master keys with the AES-CM PRF (RFC 3711 section 4.3).

use std::collections::HashMap;
use std::os::raw::{c_int, c_uchar};

use aes::Aes256;
use aes::cipher::{BlockCipherEncrypt, KeyInit};
use hkdf::Hkdf;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use sha2::Sha256;
use wasm_bindgen::prelude::*;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::{js_error, random_32};

const KEY_LEN: usize = 32;
const SALT_LEN: usize = 12;
const TAG_LEN: usize = 16;
const HKDF_INFO_PREFIX: &[u8] = b"Signal_Calling_20200807_SignallingDH_SRTPKey_KDF";
const MAX_PACKET: usize = 1500;

fn srtp_error(e: impl std::fmt::Display) -> JsValue {
    js_error("SrtpError", e)
}

/// SECURITY-REVIEW: one call's X25519 secret. It never leaves wasm; only the public key and the SRTP contexts it keys do.
#[wasm_bindgen]
pub struct CallKeyPair {
    secret: StaticSecret,
}

#[wasm_bindgen]
impl CallKeyPair {
    #[wasm_bindgen(constructor)]
    pub fn new() -> CallKeyPair {
        CallKeyPair { secret: StaticSecret::from(random_32()) }
    }

    #[wasm_bindgen(js_name = publicKey)]
    pub fn public_key(&self) -> Vec<u8> {
        PublicKey::from(&self.secret).as_bytes().to_vec()
    }

    /// The SRTP contexts for this side of the call. Identity keys are the 32-byte Curve25519 keys without the type byte, as Signal-Desktop passes them to RingRTC.
    #[wasm_bindgen(js_name = srtp)]
    pub fn srtp(&self, remote_public_key: &[u8], caller_identity_key: &[u8], callee_identity_key: &[u8], we_are_caller: bool) -> Result<SrtpPair, JsValue> {
        let remote: [u8; 32] = remote_public_key.try_into().map_err(|_| srtp_error("the remote call key is not 32 bytes"))?;
        let shared = self.secret.diffie_hellman(&PublicKey::from(remote));
        if !shared.was_contributory() {
            return Err(srtp_error("the remote call key was non-contributory"));
        }
        let mut info = Vec::with_capacity(HKDF_INFO_PREFIX.len() + caller_identity_key.len() + callee_identity_key.len());
        info.extend_from_slice(HKDF_INFO_PREFIX);
        info.extend_from_slice(caller_identity_key);
        info.extend_from_slice(callee_identity_key);
        let mut okm = [0u8; 2 * (KEY_LEN + SALT_LEN)];
        Hkdf::<Sha256>::new(Some(&[0u8; 32]), shared.as_bytes()).expand(&info, &mut okm).map_err(srtp_error)?;
        let (offer, answer) = okm.split_at(KEY_LEN + SALT_LEN);
        let (send, recv) = if we_are_caller { (offer, answer) } else { (answer, offer) };
        Ok(SrtpPair { send: SrtpContext::new(send)?, recv: SrtpContext::new(recv)? })
    }
}

impl Default for CallKeyPair {
    fn default() -> Self {
        Self::new()
    }
}

/// AES-CM PRF (RFC 3711 section 4.3.3) with a key derivation rate of 0; the 12-byte GCM master salt is zero-padded to 14 bytes as libsrtp does.
fn kdf(master_key: &[u8], master_salt: &[u8], label: u8, out: &mut [u8]) {
    let cipher = Aes256::new_from_slice(master_key).expect("32-byte master key");
    let mut iv = [0u8; 16];
    iv[..SALT_LEN].copy_from_slice(master_salt);
    iv[7] ^= label;
    for (i, chunk) in out.chunks_mut(16).enumerate() {
        let mut block = aes::Block::from(iv);
        block[14] = (i >> 8) as u8;
        block[15] = i as u8;
        cipher.encrypt_block(&mut block);
        chunk.copy_from_slice(&block[..chunk.len()]);
    }
}

struct RecvState {
    roc: u32,
    highest: u16,
    /// Bit i set means sequence `highest - i` was seen.
    window: u128,
}

struct SrtpContext {
    rtp_key: LessSafeKey,
    rtp_salt: [u8; SALT_LEN],
    send_roc: HashMap<u32, (u32, u16)>,
    recv: HashMap<u32, RecvState>,
}

impl SrtpContext {
    fn new(master: &[u8]) -> Result<SrtpContext, JsValue> {
        let (master_key, master_salt) = master.split_at(KEY_LEN);
        let mut session_key = [0u8; KEY_LEN];
        let mut rtp_salt = [0u8; SALT_LEN];
        kdf(master_key, master_salt, 0x00, &mut session_key);
        kdf(master_key, master_salt, 0x02, &mut rtp_salt);
        let rtp_key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &session_key).map_err(|_| srtp_error("bad SRTP key"))?);
        Ok(SrtpContext { rtp_key, rtp_salt, send_roc: HashMap::new(), recv: HashMap::new() })
    }

    fn nonce(&self, ssrc: u32, roc: u32, seq: u16) -> Nonce {
        let mut iv = [0u8; SALT_LEN];
        iv[2..6].copy_from_slice(&ssrc.to_be_bytes());
        iv[6..10].copy_from_slice(&roc.to_be_bytes());
        iv[10..12].copy_from_slice(&seq.to_be_bytes());
        for (b, s) in iv.iter_mut().zip(self.rtp_salt.iter()) {
            *b ^= s;
        }
        Nonce::assume_unique_for_key(iv)
    }
}

/// Length of the RTP header including CSRCs and any header extension, or None when `packet` isn't RTP.
fn rtp_header_len(packet: &[u8]) -> Option<usize> {
    if packet.len() < 12 || packet[0] >> 6 != 2 {
        return None;
    }
    let mut len = 12 + 4 * (packet[0] & 0x0f) as usize;
    if packet[0] & 0x10 != 0 {
        if packet.len() < len + 4 {
            return None;
        }
        len += 4 + 4 * u16::from_be_bytes([packet[len + 2], packet[len + 3]]) as usize;
    }
    (len <= packet.len()).then_some(len)
}

/// Both directions of one call's SRTP.
#[wasm_bindgen]
pub struct SrtpPair {
    send: SrtpContext,
    recv: SrtpContext,
}

#[wasm_bindgen]
impl SrtpPair {
    /// Encrypts one RTP packet (header and payload) and appends the tag.
    #[wasm_bindgen(js_name = protectRtp)]
    pub fn protect_rtp(&mut self, packet: &[u8]) -> Result<Vec<u8>, JsValue> {
        let header = rtp_header_len(packet).ok_or_else(|| srtp_error("not an RTP packet"))?;
        if packet.len() + TAG_LEN > MAX_PACKET {
            return Err(srtp_error("RTP packet too large"));
        }
        let ssrc = u32::from_be_bytes([packet[8], packet[9], packet[10], packet[11]]);
        let seq = u16::from_be_bytes([packet[2], packet[3]]);
        let entry = self.send.send_roc.entry(ssrc).or_insert((0, seq));
        if seq < entry.1 && entry.1 - seq > 0x8000 {
            entry.0 = entry.0.wrapping_add(1);
        }
        entry.1 = seq;
        let roc = entry.0;
        let nonce = self.send.nonce(ssrc, roc, seq);
        let mut out = packet.to_vec();
        let (head, body) = out.split_at_mut(header);
        let tag = self.send.rtp_key.seal_in_place_separate_tag(nonce, Aad::from(&*head), body).map_err(|_| srtp_error("SRTP encryption failed"))?;
        out.extend_from_slice(tag.as_ref());
        Ok(out)
    }

    /// Checks and decrypts one SRTP packet, returning the plain RTP packet. Rejects replays and forgeries.
    #[wasm_bindgen(js_name = unprotectRtp)]
    pub fn unprotect_rtp(&mut self, packet: &[u8]) -> Result<Vec<u8>, JsValue> {
        let header = rtp_header_len(packet).ok_or_else(|| srtp_error("not an RTP packet"))?;
        if packet.len() < header + TAG_LEN || packet.len() > MAX_PACKET {
            return Err(srtp_error("SRTP packet too short"));
        }
        let ssrc = u32::from_be_bytes([packet[8], packet[9], packet[10], packet[11]]);
        let seq = u16::from_be_bytes([packet[2], packet[3]]);
        let (roc, index_delta) = match self.recv.recv.get(&ssrc) {
            None => (0u32, None),
            Some(st) => {
                // RFC 3711 appendix A: pick the ROC that puts `seq` closest to the highest sequence seen.
                let roc = if st.highest < 0x8000 {
                    if seq > st.highest && seq - st.highest > 0x8000 { st.roc.wrapping_sub(1) } else { st.roc }
                } else if st.highest - 0x8000 > seq {
                    st.roc.wrapping_add(1)
                } else {
                    st.roc
                };
                let index = ((roc as i64) << 16) | seq as i64;
                let highest = ((st.roc as i64) << 16) | st.highest as i64;
                (roc, Some(index - highest))
            }
        };
        if let (Some(delta), Some(st)) = (index_delta, self.recv.recv.get(&ssrc)) {
            if delta <= 0 && (-delta >= 128 || st.window & (1u128 << (-delta)) != 0) {
                return Err(srtp_error("replayed SRTP packet"));
            }
        }
        let nonce = self.recv.nonce(ssrc, roc, seq);
        let mut out = packet.to_vec();
        let (head, body) = out.split_at_mut(header);
        let plain_len = self.recv.rtp_key.open_in_place(nonce, Aad::from(&*head), body).map_err(|_| srtp_error("SRTP authentication failed"))?.len();
        out.truncate(header + plain_len);
        match (self.recv.recv.get_mut(&ssrc), index_delta) {
            (Some(st), Some(delta)) if delta > 0 => {
                st.window = if delta >= 128 { 1 } else { (st.window << delta) | 1 };
                st.highest = seq;
                st.roc = roc;
            }
            (Some(st), Some(delta)) => st.window |= 1u128 << (-delta),
            _ => {
                self.recv.recv.insert(ssrc, RecvState { roc, highest: seq, window: 1 });
            }
        }
        Ok(out)
    }
}

#[repr(C)]
struct OpusEncoderState {
    _private: [u8; 0],
}
#[repr(C)]
struct OpusDecoderState {
    _private: [u8; 0],
}

unsafe extern "C" {
    fn opus_encoder_create(fs: i32, channels: c_int, application: c_int, error: *mut c_int) -> *mut OpusEncoderState;
    fn opus_encoder_destroy(st: *mut OpusEncoderState);
    fn opus_encode_float(st: *mut OpusEncoderState, pcm: *const f32, frame_size: c_int, data: *mut c_uchar, max_data_bytes: i32) -> i32;
    fn opus_encoder_ctl(st: *mut OpusEncoderState, request: c_int, ...) -> c_int;
    fn opus_decoder_create(fs: i32, channels: c_int, error: *mut c_int) -> *mut OpusDecoderState;
    fn opus_decoder_destroy(st: *mut OpusDecoderState);
    fn opus_decode_float(st: *mut OpusDecoderState, data: *const c_uchar, len: i32, pcm: *mut f32, frame_size: c_int, decode_fec: c_int) -> c_int;
}

const OPUS_APPLICATION_VOIP: c_int = 2048;
const OPUS_SET_BITRATE_REQUEST: c_int = 4002;
const OPUS_SET_VBR_REQUEST: c_int = 4006;
const OPUS_SET_COMPLEXITY_REQUEST: c_int = 4010;
const OPUS_SET_INBAND_FEC_REQUEST: c_int = 4012;
const OPUS_SET_PACKET_LOSS_PERC_REQUEST: c_int = 4014;
const OPUS_SET_DTX_REQUEST: c_int = 4016;
const OPUS_SET_SIGNAL_REQUEST: c_int = 4024;
const OPUS_SIGNAL_VOICE: c_int = 3001;
/// 120 ms at 48 kHz, Opus's longest frame.
const MAX_FRAME_SAMPLES: usize = 5760;

fn opus_error(what: &str, code: c_int) -> JsValue {
    js_error("OpusError", format!("{what} failed ({code})"))
}

/// A mono Opus encoder configured like RingRTC's (CBR, in-band FEC, DTX), at a lower complexity for the phone's CPU.
#[wasm_bindgen]
pub struct OpusEncoder {
    st: *mut OpusEncoderState,
}

#[wasm_bindgen]
impl OpusEncoder {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: i32, bitrate: i32, complexity: i32) -> Result<OpusEncoder, JsValue> {
        let mut err: c_int = 0;
        let st = unsafe { opus_encoder_create(sample_rate, 1, OPUS_APPLICATION_VOIP, &mut err) };
        if st.is_null() || err != 0 {
            return Err(opus_error("opus_encoder_create", err));
        }
        let enc = OpusEncoder { st };
        for (req, value) in [
            (OPUS_SET_BITRATE_REQUEST, bitrate),
            (OPUS_SET_VBR_REQUEST, 0),
            (OPUS_SET_COMPLEXITY_REQUEST, complexity),
            (OPUS_SET_INBAND_FEC_REQUEST, 1),
            (OPUS_SET_PACKET_LOSS_PERC_REQUEST, 10),
            (OPUS_SET_DTX_REQUEST, 1),
            (OPUS_SET_SIGNAL_REQUEST, OPUS_SIGNAL_VOICE),
        ] {
            let rc = unsafe { opus_encoder_ctl(enc.st, req, value as c_int) };
            if rc != 0 {
                return Err(opus_error("opus_encoder_ctl", rc));
            }
        }
        Ok(enc)
    }

    /// Encodes one frame of mono samples (2.5 to 120 ms at the encoder's rate).
    pub fn encode(&mut self, pcm: &[f32]) -> Result<Vec<u8>, JsValue> {
        let mut out = vec![0u8; 1276];
        let n = unsafe { opus_encode_float(self.st, pcm.as_ptr(), pcm.len() as c_int, out.as_mut_ptr(), out.len() as i32) };
        if n < 0 {
            return Err(opus_error("opus_encode", n));
        }
        out.truncate(n as usize);
        Ok(out)
    }

    /// Changes the encoder's complexity (0 to 10) mid-stream.
    #[wasm_bindgen(js_name = setComplexity)]
    pub fn set_complexity(&mut self, complexity: i32) -> Result<(), JsValue> {
        let rc = unsafe { opus_encoder_ctl(self.st, OPUS_SET_COMPLEXITY_REQUEST, complexity as c_int) };
        if rc != 0 {
            return Err(opus_error("opus_encoder_ctl", rc));
        }
        Ok(())
    }
}

impl Drop for OpusEncoder {
    fn drop(&mut self) {
        unsafe { opus_encoder_destroy(self.st) }
    }
}

#[wasm_bindgen]
pub struct OpusDecoder {
    st: *mut OpusDecoderState,
    pcm: Vec<f32>,
}

#[wasm_bindgen]
impl OpusDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: i32) -> Result<OpusDecoder, JsValue> {
        let mut err: c_int = 0;
        let st = unsafe { opus_decoder_create(sample_rate, 1, &mut err) };
        if st.is_null() || err != 0 {
            return Err(opus_error("opus_decoder_create", err));
        }
        Ok(OpusDecoder { st, pcm: vec![0f32; MAX_FRAME_SAMPLES] })
    }

    /// Decodes one packet. With `packet` empty, conceals a lost frame of `frame_samples`; with `fec`, recovers the frame before `packet` from its in-band FEC.
    pub fn decode(&mut self, packet: &[u8], frame_samples: usize, fec: bool) -> Result<Vec<f32>, JsValue> {
        let size = if packet.is_empty() || fec { frame_samples.min(MAX_FRAME_SAMPLES) } else { MAX_FRAME_SAMPLES };
        let data = if packet.is_empty() { std::ptr::null() } else { packet.as_ptr() };
        let n = unsafe { opus_decode_float(self.st, data, packet.len() as i32, self.pcm.as_mut_ptr(), size as c_int, fec as c_int) };
        if n < 0 {
            return Err(opus_error("opus_decode", n));
        }
        Ok(self.pcm[..n as usize].to_vec())
    }
}

impl Drop for OpusDecoder {
    fn drop(&mut self) {
        unsafe { opus_decoder_destroy(self.st) }
    }
}

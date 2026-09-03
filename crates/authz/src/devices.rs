//! Devices: pairing, credentials, revocation.
//!
//! One process serves one user, but that user has more than one machine. A
//! device is that person on one of them — not a tenant, and not an account
//! (concept_and_architecture.md §6.3).
//!
//! # Why a keypair and a challenge, rather than a shared secret
//!
//! A long-lived bearer token is replayable by anything that ever saw it: a
//! proxy log, a shell history, a screenshot. The device keeps a private key
//! and proves possession per session by signing a challenge the server chose,
//! so what travels is never reusable. No CA, no identity provider, nothing to
//! run alongside — the pairing code carries the trust across once, and after
//! that the keypair carries it.
//!
//! # A pairing code is short-lived and single-use
//!
//! It is read off one screen and typed into another, so it is short, and
//! everything about it follows from that: it expires in minutes, it is spent
//! on first use, and a wrong guess burns an attempt. A code that stayed valid
//! would be a password with none of a password's length.
//!
//! # Revocation is immediate and total
//!
//! A credential belongs to the subject, not to a connection (§3.3.3, item 2),
//! so revoking a device ends **all** of its channels at once rather than
//! whichever one happens to be noticed next.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// How long a pairing code is worth typing. Long enough to walk to the other
/// machine, short enough that a code left on a screen is not a standing door.
pub const PAIRING_TTL: Duration = Duration::from_secs(300);

/// Wrong guesses a code survives. The third one burns it.
///
/// A six-character code deserves very few: the point is that guessing is not
/// a strategy, and the person typing it has the code in front of them.
const MAX_ATTEMPTS: u8 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    /// What the person will recognize it by in the list.
    pub label: String,
    /// The device's public key, base64. What a challenge is verified against.
    pub public_key: String,
    pub paired_at: String,
    #[serde(default)]
    pub last_seen: Option<String>,
}

/// A code waiting to be typed in.
struct Pending {
    code_hash: String,
    label: String,
    expires: SystemTime,
    attempts: u8,
}

/// A wrong guess has to be able to find the window it is guessing at.
///
/// Keying pending windows by the hash of the code they are waiting for looks
/// tidy and is wrong: a wrong guess hashes to a different key, finds nothing,
/// and is refused **without spending an attempt** — which makes the attempt
/// limit decorative and the code guessable at leisure. So a guess is compared
/// against every open window, and a guess that matches none costs an attempt
/// on all of them. A person opens one window at a time, so "all of them" is
/// the one they are looking at.

#[derive(Debug)]
pub enum PairError {
    /// No such code, it expired, or it was already spent. **One error for all
    /// three**: telling them apart tells an attacker which guesses were
    /// closer.
    Refused,
    TooManyAttempts,
}

impl std::fmt::Display for PairError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PairError::Refused => write!(f, "pairing code is not valid"),
            PairError::TooManyAttempts => write!(f, "too many attempts; ask for a new code"),
        }
    }
}

#[derive(Default)]
pub struct Devices {
    paired: Mutex<HashMap<String, Device>>,
    pending: Mutex<HashMap<String, Pending>>,
}

impl Devices {
    pub fn new(paired: Vec<Device>) -> Self {
        Self {
            paired: Mutex::new(paired.into_iter().map(|d| (d.id.clone(), d)).collect()),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Open a pairing window, and return its handle.
    ///
    /// Only the hash of the code is kept: a code sitting in this process's
    /// memory in the clear is a code that ends up in a core dump. The handle
    /// is independent of the code — see [`Pending`] for why that matters.
    pub fn begin_pairing(&self, code: &str, label: impl Into<String>, now: SystemTime) -> String {
        let handle = format!("pair-{}", uuid_like(code, now));
        self.pending.lock().unwrap().insert(
            handle.clone(),
            Pending {
                code_hash: hash(code),
                label: label.into(),
                expires: now + PAIRING_TTL,
                attempts: 0,
            },
        );
        handle
    }

    /// Redeem a code for a lasting device record.
    pub fn complete_pairing(
        &self,
        code: &str,
        public_key: &str,
        now: SystemTime,
        stamp: &str,
    ) -> Result<Device, PairError> {
        let guess = hash(code);
        let mut pending = self.pending.lock().unwrap();
        pending.retain(|_, p| now <= p.expires);

        // Constant-time over the hashes, so a comparison that stops early
        // does not leak how much of a guess was right.
        let matched = pending
            .iter()
            .find(|(_, p)| constant_time_eq(p.code_hash.as_bytes(), guess.as_bytes()))
            .map(|(handle, p)| (handle.clone(), p.label.clone()));

        let Some((handle, label)) = matched else {
            // Nothing matched: charge every open window, and burn the ones
            // that have now been guessed at too often.
            let mut exhausted = false;
            for entry in pending.values_mut() {
                entry.attempts += 1;
                exhausted |= entry.attempts >= MAX_ATTEMPTS;
            }
            pending.retain(|_, p| p.attempts < MAX_ATTEMPTS);
            return Err(if exhausted { PairError::TooManyAttempts } else { PairError::Refused });
        };
        pending.remove(&handle);
        drop(pending);

        let device = Device {
            id: format!("dev-{}", &guess[..12]),
            label,
            public_key: public_key.to_string(),
            paired_at: stamp.to_string(),
            last_seen: None,
        };
        self.paired.lock().unwrap().insert(device.id.clone(), device.clone());
        Ok(device)
    }

    pub fn list(&self) -> Vec<Device> {
        let mut all: Vec<Device> = self.paired.lock().unwrap().values().cloned().collect();
        all.sort_by(|a, b| a.paired_at.cmp(&b.paired_at));
        all
    }

    pub fn get(&self, id: &str) -> Option<Device> {
        self.paired.lock().unwrap().get(id).cloned()
    }

    /// Forget a device. Its channels are ended by the caller, which is the
    /// only layer that knows there are channels.
    pub fn revoke(&self, id: &str) -> bool {
        self.paired.lock().unwrap().remove(id).is_some()
    }

    pub fn is_paired(&self, id: &str) -> bool {
        self.paired.lock().unwrap().contains_key(id)
    }

    /// Drop pairing windows that nobody used.
    pub fn sweep(&self, now: SystemTime) {
        self.pending.lock().unwrap().retain(|_, p| now <= p.expires);
    }
}

/// A handle that does not depend on the code. Derived rather than random so
/// this crate stays free of a randomness source it would otherwise need only
/// here; it is an identifier, not a secret — the code is the secret.
fn uuid_like(code: &str, now: SystemTime) -> String {
    let stamp = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(stamp.to_le_bytes());
    hasher.update(code.len().to_le_bytes());
    hex::encode(hasher.finalize())[..16].to_string()
}

fn hash(code: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(code.as_bytes());
    hex::encode(hasher.finalize())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000)
    }

    #[test]
    fn a_code_pairs_once_and_then_is_spent() {
        let devices = Devices::default();
        devices.begin_pairing("ABC123", "laptop", now());
        let device = devices.complete_pairing("ABC123", "pk", now(), "t0").expect("pairs");
        assert!(devices.is_paired(&device.id));
        // Spent. A code that could be redeemed twice would be a code worth
        // stealing off a screen after it had already been used.
        assert!(matches!(
            devices.complete_pairing("ABC123", "pk2", now(), "t1"),
            Err(PairError::Refused)
        ));
    }

    #[test]
    fn an_expired_code_is_refused() {
        let devices = Devices::default();
        devices.begin_pairing("ABC123", "laptop", now());
        let late = now() + PAIRING_TTL + Duration::from_secs(1);
        assert!(matches!(
            devices.complete_pairing("ABC123", "pk", late, "t0"),
            Err(PairError::Refused)
        ));
    }

    /// Guessing is not a strategy.
    ///
    /// This is the test that caught the version where the pending window was
    /// keyed by the hash of the code it was waiting for: a wrong guess found
    /// no window, spent no attempt, and could be repeated forever.
    #[test]
    fn wrong_guesses_burn_the_code() {
        let devices = Devices::default();
        devices.begin_pairing("ABC123", "laptop", now());
        for _ in 0..MAX_ATTEMPTS {
            assert!(devices.complete_pairing("WRONG!", "pk", now(), "t").is_err());
        }
        // Burned — even the right code no longer works.
        assert!(devices.complete_pairing("ABC123", "pk", now(), "t").is_err());
    }

    /// And the refusal never says how close a guess was: no such code, an
    /// expired one, and a spent one are one answer.
    #[test]
    fn a_refusal_says_nothing_about_the_guess() {
        let devices = Devices::default();
        let nothing_open = devices.complete_pairing("ABC123", "pk", now(), "t");
        devices.begin_pairing("ABC123", "laptop", now());
        let wrong_guess = devices.complete_pairing("ZZZ999", "pk", now(), "t");
        assert_eq!(
            format!("{}", nothing_open.unwrap_err()),
            format!("{}", wrong_guess.unwrap_err()),
        );
    }

    #[test]
    fn revoking_forgets_the_device() {
        let devices = Devices::default();
        devices.begin_pairing("ABC123", "laptop", now());
        let device = devices.complete_pairing("ABC123", "pk", now(), "t0").unwrap();
        assert!(devices.revoke(&device.id));
        assert!(!devices.is_paired(&device.id));
        assert!(!devices.revoke(&device.id));
    }
}

/// Proving possession of a device's private key.
///
/// The server picks the challenge, so what travels is never replayable — a
/// bearer token that ever appeared in a proxy log, a shell history or a
/// screenshot is reusable by whoever saw it, and this is not.
pub mod challenge {
    use base64::Engine as _;

    /// Bytes a challenge is made of. Enough that guessing one is not a
    /// strategy; small enough to fit in a query parameter.
    pub const LEN: usize = 32;

    /// Does this signature prove possession of the key that was paired?
    ///
    /// Ed25519. Everything about a malformed key, a malformed signature and a
    /// wrong signature is one answer — `false` — because they are one answer
    /// to the question actually being asked.
    pub fn verify(public_key_b64: &str, challenge: &[u8], signature_b64: &str) -> bool {
        let engine = base64::engine::general_purpose::STANDARD;
        let (Ok(key), Ok(signature)) = (engine.decode(public_key_b64), engine.decode(signature_b64))
        else {
            return false;
        };
        ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
            .verify(challenge, &signature)
            .is_ok()
    }
}

#[cfg(test)]
mod challenge_tests {
    use super::challenge;
    use base64::Engine as _;
    use ring::signature::KeyPair;

    fn keypair() -> (String, ring::signature::Ed25519KeyPair) {
        let rng = ring::rand::SystemRandom::new();
        let doc = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8(doc.as_ref()).unwrap();
        let public = base64::engine::general_purpose::STANDARD.encode(pair.public_key().as_ref());
        (public, pair)
    }

    #[test]
    fn a_signature_from_the_paired_key_verifies() {
        let (public, pair) = keypair();
        let challenge = [7u8; challenge::LEN];
        let signature =
            base64::engine::general_purpose::STANDARD.encode(pair.sign(&challenge).as_ref());
        assert!(challenge::verify(&public, &challenge, &signature));
    }

    /// The point of the server choosing the challenge: a signature is worth
    /// nothing anywhere else.
    #[test]
    fn a_signature_does_not_transfer_to_another_challenge() {
        let (public, pair) = keypair();
        let signature =
            base64::engine::general_purpose::STANDARD.encode(pair.sign(&[7u8; 32]).as_ref());
        assert!(!challenge::verify(&public, &[8u8; 32], &signature));
    }

    #[test]
    fn another_key_does_not_verify() {
        let (_, pair) = keypair();
        let (other_public, _) = keypair();
        let challenge = [7u8; challenge::LEN];
        let signature =
            base64::engine::general_purpose::STANDARD.encode(pair.sign(&challenge).as_ref());
        assert!(!challenge::verify(&other_public, &challenge, &signature));
    }

    /// Malformed input is one answer with a wrong signature, because it is
    /// one answer to the question being asked.
    #[test]
    fn garbage_is_refused_rather_than_panicking() {
        assert!(!challenge::verify("not base64!!", &[0u8; 32], "also not"));
        assert!(!challenge::verify("", &[], ""));
    }
}

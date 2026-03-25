/// Vesper OpenMLS WASM bindings
///
/// Extended from the official openmls-wasm with:
/// - External Commits (RFC 9420 §12.4) — the key feature for offline joins
/// - GroupInfo export/import — required for External Commit flow
/// - Member listing — needed for the orchestration layer
/// - Voice key derivation — needed for WebRTC E2EE
/// - Remove member — needed for group management
/// - State serialization — needed for persistence
///
/// Maps to the Vesper mls.ts API surface.
use js_sys::Uint8Array;
use openmls::{
    credentials::{BasicCredential, CredentialWithKey},
    framing::{MlsMessageBodyIn, MlsMessageIn, MlsMessageOut, ProcessedMessageContent},
    group::{GroupId, MlsGroup, MlsGroupJoinConfig, StagedWelcome},
    key_packages::KeyPackage as OpenMlsKeyPackage,
    prelude::{LeafNodeIndex, SignatureScheme},
    treesync::RatchetTreeIn,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::{types::Ciphersuite, OpenMlsProvider};
use tls_codec::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

macro_rules! console_log {
    ($($t:tt)*) => (log(&format!($($t)*)))
}

/// The ciphersuite used by Vesper — matches the ts-mls config
static CIPHERSUITE: Ciphersuite =
    Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

/// Epoch key retention depth — matches the ts-mls config (64 epochs)
const RETAIN_KEYS_FOR_EPOCHS: usize = 64;

// ============================================================
// Provider
// ============================================================

#[wasm_bindgen]
#[derive(Default)]
pub struct Provider(OpenMlsRustCrypto);

#[wasm_bindgen]
impl Provider {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        #[cfg(feature = "console_error_panic_hook")]
        console_error_panic_hook::set_once();
        Self::default()
    }
}

// ============================================================
// Identity
// ============================================================

#[wasm_bindgen]
pub struct Identity {
    credential_with_key: CredentialWithKey,
    keypair: SignatureKeyPair,
}

#[wasm_bindgen]
impl Identity {
    /// Create a new identity with the given name.
    /// The name format should be "userId:deviceId" to match Vesper's convention.
    #[wasm_bindgen(constructor)]
    pub fn new(provider: &Provider, name: &str) -> Result<Identity, JsError> {
        let identity = name.bytes().collect();
        let credential = BasicCredential::new(identity);
        let keypair = SignatureKeyPair::new(SignatureScheme::ED25519)?;

        keypair.store(provider.0.storage())?;

        let credential_with_key = CredentialWithKey {
            credential: credential.into(),
            signature_key: keypair.public().into(),
        };

        Ok(Identity {
            credential_with_key,
            keypair,
        })
    }

    /// Generate a key package for this identity
    pub fn key_package(&self, provider: &Provider) -> KeyPackage {
        KeyPackage(
            OpenMlsKeyPackage::builder()
                .build(
                    CIPHERSUITE,
                    &provider.0,
                    &self.keypair,
                    self.credential_with_key.clone(),
                )
                .unwrap()
                .key_package()
                .clone(),
        )
    }

    /// Get the identity name (e.g., "userId:deviceId")
    pub fn name(&self) -> String {
        let credential = &self.credential_with_key.credential;
        let basic = BasicCredential::try_from(credential.clone()).unwrap();
        String::from_utf8(basic.identity().to_vec()).unwrap()
    }
}

// ============================================================
// KeyPackage
// ============================================================

#[wasm_bindgen]
pub struct KeyPackage(OpenMlsKeyPackage);

#[wasm_bindgen]
impl KeyPackage {
    /// Serialize this KeyPackage to bytes
    pub fn to_bytes(&self) -> Vec<u8> {
        self.0.tls_serialize_detached().unwrap()
    }

    /// Deserialize a KeyPackage from bytes
    pub fn from_bytes(bytes: &[u8]) -> Result<KeyPackage, JsError> {
        let mut s = bytes;
        let kp_in = openmls::key_packages::KeyPackageIn::tls_deserialize(&mut s)
            .map_err(|e| JsError::new(&format!("KeyPackage deserialization error: {e}")))?;
        let kp = kp_in
            .validate(
                &openmls_rust_crypto::RustCrypto::default(),
                openmls::prelude::ProtocolVersion::Mls10,
            )
            .map_err(|e| JsError::new(&format!("KeyPackage validation error: {e}")))?;
        Ok(KeyPackage(kp))
    }
}

// ============================================================
// RatchetTree
// ============================================================

#[wasm_bindgen]
pub struct RatchetTree(RatchetTreeIn);

#[wasm_bindgen]
impl RatchetTree {
    pub fn to_bytes(&self) -> Vec<u8> {
        self.0.tls_serialize_detached().unwrap()
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<RatchetTree, JsError> {
        let mut s = bytes;
        let tree = RatchetTreeIn::tls_deserialize(&mut s)
            .map_err(|e| JsError::new(&format!("RatchetTree deserialization error: {e}")))?;
        Ok(RatchetTree(tree))
    }
}

// ============================================================
// GroupInfo (for External Commits)
// ============================================================

#[wasm_bindgen]
pub struct GroupInfo {
    bytes: Vec<u8>,
}

#[wasm_bindgen]
impl GroupInfo {
    pub fn to_bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }

    pub fn from_bytes(bytes: &[u8]) -> GroupInfo {
        GroupInfo {
            bytes: bytes.to_vec(),
        }
    }
}

// ============================================================
// CommitBundle — returned from add/remove/external-commit operations
// ============================================================

#[wasm_bindgen]
pub struct CommitBundle {
    commit_bytes: Vec<u8>,
    welcome_bytes: Option<Vec<u8>>,
    group_info_bytes: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl CommitBundle {
    #[wasm_bindgen(getter)]
    pub fn commit(&self) -> Vec<u8> {
        self.commit_bytes.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn welcome(&self) -> Option<Vec<u8>> {
        self.welcome_bytes.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn group_info(&self) -> Option<Vec<u8>> {
        self.group_info_bytes.clone()
    }
}

// ============================================================
// ProcessResult — returned from processing incoming messages
// ============================================================

#[wasm_bindgen]
pub struct ProcessResult {
    kind: String,
    application_message: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl ProcessResult {
    /// "application", "commit", "proposal"
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> String {
        self.kind.clone()
    }

    /// The decrypted application message, if kind == "application"
    #[wasm_bindgen(getter)]
    pub fn message(&self) -> Option<Vec<u8>> {
        self.application_message.clone()
    }
}

// ============================================================
// Group
// ============================================================

#[wasm_bindgen]
pub struct Group {
    mls_group: MlsGroup,
}

#[wasm_bindgen]
impl Group {
    /// Create a new MLS group. The founder is the first member.
    pub fn create_new(provider: &Provider, founder: &Identity, group_id: &str) -> Group {
        let group_id_bytes = group_id.bytes().collect::<Vec<_>>();

        let mls_group = MlsGroup::builder()
            .ciphersuite(CIPHERSUITE)
            .with_group_id(GroupId::from_slice(&group_id_bytes))
            .build(
                &provider.0,
                &founder.keypair,
                founder.credential_with_key.clone(),
            )
            .unwrap();

        Group { mls_group }
    }

    /// Join a group via Welcome message (traditional flow)
    pub fn join_from_welcome(
        provider: &Provider,
        welcome_bytes: &[u8],
        ratchet_tree: Option<RatchetTree>,
    ) -> Result<Group, JsError> {
        let mut buf = welcome_bytes;
        let welcome = match MlsMessageIn::tls_deserialize(&mut buf)?.extract() {
            MlsMessageBodyIn::Welcome(w) => Ok(w),
            other => Err(JsError::new(&format!(
                "expected Welcome, got {other:?}"
            ))),
        }?;

        let config = MlsGroupJoinConfig::builder().build();
        let tree = ratchet_tree.map(|rt| rt.0);
        let mls_group =
            StagedWelcome::new_from_welcome(&provider.0, &config, welcome, tree)?
                .into_group(&provider.0)?;

        Ok(Group { mls_group })
    }

    /// Join a group via External Commit (RFC 9420 §12.4).
    ///
    /// This is the key feature: the new member adds themselves using
    /// published GroupInfo. No existing member needs to be online.
    ///
    /// Returns the new Group and a CommitBundle containing the external
    /// commit message that must be fanned out to other members.
    pub fn join_from_external_commit(
        provider: &Provider,
        joiner: &Identity,
        group_info_bytes: &[u8],
        ratchet_tree: Option<RatchetTree>,
    ) -> Result<ExternalCommitResult, JsError> {
        // Deserialize the GroupInfo
        let mut buf = group_info_bytes;
        let verifiable_group_info = match MlsMessageIn::tls_deserialize(&mut buf)?.extract() {
            MlsMessageBodyIn::GroupInfo(gi) => gi,
            other => {
                return Err(JsError::new(&format!(
                    "expected GroupInfo, got {other:?}"
                )))
            }
        };

        let config = MlsGroupJoinConfig::builder().build();

        let mut builder = MlsGroup::external_commit_builder()
            .with_config(config);

        if let Some(rt) = ratchet_tree {
            builder = builder.with_ratchet_tree(rt.0);
        }

        let (group, commit_message_bundle) = builder
            .build_group(
                &provider.0,
                verifiable_group_info,
                joiner.credential_with_key.clone(),
            )
            .map_err(|e| JsError::new(&format!("error building group from external commit: {e}")))?
            .load_psks(provider.0.storage())
            .map_err(|e| JsError::new(&format!("error loading PSKs: {e}")))?
            .build(
                provider.0.rand(),
                provider.0.crypto(),
                &joiner.keypair,
                |_| true, // Accept all credentials (Vesper does its own auth)
            )
            .map_err(|e| JsError::new(&format!("error building external commit: {e}")))?
            .finalize(&provider.0)
            .map_err(|e| JsError::new(&format!("error finalizing external commit: {e}")))?;

        // Serialize the commit
        let commit_msg = commit_message_bundle.into_commit();
        let mut commit_bytes = vec![];
        commit_msg.tls_serialize(&mut commit_bytes)?;

        Ok(ExternalCommitResult {
            group: Group { mls_group: group },
            commit_bytes,
        })
    }

    /// Export GroupInfo for External Commit flow.
    /// This should be published to the server after each epoch change.
    pub fn export_group_info(
        &self,
        provider: &Provider,
        signer: &Identity,
    ) -> Result<Vec<u8>, JsError> {
        let group_info_msg = self
            .mls_group
            .export_group_info(provider.0.crypto(), &signer.keypair, true)
            .map_err(|e| JsError::new(&format!("error exporting group info: {e}")))?;

        let mut bytes = vec![];
        group_info_msg.tls_serialize(&mut bytes)?;
        Ok(bytes)
    }

    /// Export the ratchet tree (needed for External Commit if not embedded in GroupInfo)
    pub fn export_ratchet_tree(&self) -> RatchetTree {
        RatchetTree(self.mls_group.export_ratchet_tree().into())
    }

    /// Add a member to the group (traditional Welcome-based flow)
    pub fn add_member(
        &mut self,
        provider: &Provider,
        sender: &Identity,
        new_member: &KeyPackage,
    ) -> Result<CommitBundle, JsError> {
        let (proposal_msg, _proposal_ref) =
            self.mls_group
                .propose_add_member(&provider.0, &sender.keypair, &new_member.0)?;

        let (commit_msg, welcome_msg, group_info_opt) = self
            .mls_group
            .commit_to_pending_proposals(&provider.0, &sender.keypair)?;

        let mut commit_bytes = vec![];
        commit_msg.tls_serialize(&mut commit_bytes)?;

        let welcome_bytes = welcome_msg.map(|w| {
            let mut b = vec![];
            w.tls_serialize(&mut b).unwrap();
            b
        });

        let group_info_bytes = group_info_opt.map(|gi| {
            let mut b = vec![];
            gi.tls_serialize(&mut b).unwrap();
            b
        });

        Ok(CommitBundle {
            commit_bytes,
            welcome_bytes,
            group_info_bytes,
        })
    }

    /// Remove a member by leaf index
    pub fn remove_member(
        &mut self,
        provider: &Provider,
        sender: &Identity,
        leaf_index: u32,
    ) -> Result<CommitBundle, JsError> {
        let member = self
            .mls_group
            .member_at(LeafNodeIndex::new(leaf_index))
            .ok_or_else(|| JsError::new(&format!("No member at leaf index {leaf_index}")))?;

        self.mls_group
            .propose_remove_member(&provider.0, &sender.keypair, member.index)?;

        let (commit_msg, welcome_msg, group_info_opt) = self
            .mls_group
            .commit_to_pending_proposals(&provider.0, &sender.keypair)?;

        let mut commit_bytes = vec![];
        commit_msg.tls_serialize(&mut commit_bytes)?;

        let welcome_bytes = welcome_msg.map(|w| {
            let mut b = vec![];
            w.tls_serialize(&mut b).unwrap();
            b
        });

        let group_info_bytes = group_info_opt.map(|gi| {
            let mut b = vec![];
            gi.tls_serialize(&mut b).unwrap();
            b
        });

        Ok(CommitBundle {
            commit_bytes,
            welcome_bytes,
            group_info_bytes,
        })
    }

    /// Merge a pending commit (after add/remove/external commit)
    pub fn merge_pending_commit(&mut self, provider: &Provider) -> Result<(), JsError> {
        self.mls_group
            .merge_pending_commit(&provider.0)
            .map_err(|e| e.into())
    }

    /// Create an encrypted application message
    pub fn create_message(
        &mut self,
        provider: &Provider,
        sender: &Identity,
        msg: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let msg_out = self
            .mls_group
            .create_message(&provider.0, &sender.keypair, msg)?;
        let mut serialized = vec![];
        msg_out.tls_serialize(&mut serialized)?;
        Ok(serialized)
    }

    /// Process an incoming MLS message (commit, proposal, or application message)
    pub fn process_message(
        &mut self,
        provider: &Provider,
        msg: &[u8],
    ) -> Result<ProcessResult, JsError> {
        let mut buf = msg;
        let mls_msg = MlsMessageIn::tls_deserialize(&mut buf)?;

        let processed = match mls_msg.extract() {
            MlsMessageBodyIn::PublicMessage(msg) => {
                self.mls_group.process_message(&provider.0, msg)?
            }
            MlsMessageBodyIn::PrivateMessage(msg) => {
                self.mls_group.process_message(&provider.0, msg)?
            }
            other => {
                return Err(JsError::new(&format!(
                    "unexpected message type: {other:?}"
                )))
            }
        };

        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app_msg) => Ok(ProcessResult {
                kind: "application".to_string(),
                application_message: Some(app_msg.into_bytes()),
            }),
            ProcessedMessageContent::ProposalMessage(proposal)
            | ProcessedMessageContent::ExternalJoinProposalMessage(proposal) => {
                self.mls_group
                    .store_pending_proposal(provider.0.storage(), *proposal)?;
                Ok(ProcessResult {
                    kind: "proposal".to_string(),
                    application_message: None,
                })
            }
            ProcessedMessageContent::StagedCommitMessage(staged_commit) => {
                self.mls_group
                    .merge_staged_commit(&provider.0, *staged_commit)?;
                Ok(ProcessResult {
                    kind: "commit".to_string(),
                    application_message: None,
                })
            }
        }
    }

    /// Export a secret from the group's key schedule (e.g., for voice key derivation)
    pub fn export_secret(
        &self,
        provider: &Provider,
        label: &str,
        context: &[u8],
        key_length: usize,
    ) -> Result<Vec<u8>, JsError> {
        self.mls_group
            .export_secret(provider.0.crypto(), label, context, key_length)
            .map_err(|e| e.into())
    }

    /// Get the current epoch number
    pub fn epoch(&self) -> u64 {
        self.mls_group.epoch().as_u64()
    }

    /// Get the group ID as a string
    pub fn group_id(&self) -> String {
        String::from_utf8(self.mls_group.group_id().as_slice().to_vec())
            .unwrap_or_else(|_| format!("{:?}", self.mls_group.group_id().as_slice()))
    }

    /// Get member identities as a JSON array of strings
    pub fn member_identities(&self) -> String {
        let identities: Vec<String> = self
            .mls_group
            .members()
            .filter_map(|member| {
                let credential = member.credential;
                if let Ok(basic) = BasicCredential::try_from(credential) {
                    String::from_utf8(basic.identity().to_vec()).ok()
                } else {
                    None
                }
            })
            .collect();

        serde_json::to_string(&identities).unwrap()
    }

    /// Get the number of members in the group
    pub fn member_count(&self) -> usize {
        self.mls_group.members().count()
    }
}

// ============================================================
// ExternalCommitResult
// ============================================================

#[wasm_bindgen]
pub struct ExternalCommitResult {
    group: Group,
    commit_bytes: Vec<u8>,
}

#[wasm_bindgen]
impl ExternalCommitResult {
    /// Take the group (consumes this field)
    pub fn take_group(self) -> Group {
        self.group
    }

    /// Get the external commit bytes to fan out to existing members
    pub fn commit_bytes(&self) -> Vec<u8> {
        self.commit_bytes.clone()
    }
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_group_create_and_message() {
        let alice_provider = Provider::new();
        let bob_provider = Provider::new();

        let alice = Identity::new(&alice_provider, "alice:device1").unwrap();
        let bob = Identity::new(&bob_provider, "bob:device1").unwrap();

        let mut alice_group = Group::create_new(&alice_provider, &alice, "test-group");
        let bob_kp = bob.key_package(&bob_provider);

        let bundle = alice_group
            .add_member(&alice_provider, &alice, &bob_kp)
            .unwrap();

        alice_group.merge_pending_commit(&alice_provider).unwrap();

        let ratchet_tree = alice_group.export_ratchet_tree();
        let mut bob_group = Group::join_from_welcome(
            &bob_provider,
            &bundle.welcome_bytes.unwrap(),
            Some(ratchet_tree),
        )
        .unwrap();

        // Alice sends a message
        let msg = b"Hello, Bob!";
        let encrypted = alice_group
            .create_message(&alice_provider, &alice, msg)
            .unwrap();

        let result = bob_group
            .process_message(&bob_provider, &encrypted)
            .unwrap();

        assert_eq!(result.kind, "application");
        assert_eq!(result.application_message.unwrap(), msg);
    }

    #[test]
    fn external_commit_flow() {
        let alice_provider = Provider::new();
        let charlie_provider = Provider::new();

        let alice = Identity::new(&alice_provider, "alice:device1").unwrap();
        let charlie = Identity::new(&charlie_provider, "charlie:device1").unwrap();

        // Alice creates a group
        let mut alice_group = Group::create_new(&alice_provider, &alice, "ext-commit-group");

        // Alice exports GroupInfo (would be published to server)
        let group_info_bytes = alice_group
            .export_group_info(&alice_provider, &alice)
            .unwrap();

        let ratchet_tree = alice_group.export_ratchet_tree();

        // Charlie joins via External Commit — no Welcome needed!
        let ext_result = Group::join_from_external_commit(
            &charlie_provider,
            &charlie,
            &group_info_bytes,
            Some(ratchet_tree),
        )
        .unwrap();

        let ext_commit_bytes = ext_result.commit_bytes();
        let mut charlie_group = ext_result.take_group();

        // Alice processes the external commit
        let result = alice_group
            .process_message(&alice_provider, &ext_commit_bytes)
            .unwrap();
        assert_eq!(result.kind, "commit");

        // Both groups should now have 2 members
        assert_eq!(alice_group.member_count(), 2);
        assert_eq!(charlie_group.member_count(), 2);

        // Test messaging after external commit join
        let msg = b"I joined without anyone adding me!";
        let encrypted = charlie_group
            .create_message(&charlie_provider, &charlie, msg)
            .unwrap();

        let result = alice_group
            .process_message(&alice_provider, &encrypted)
            .unwrap();
        assert_eq!(result.kind, "application");
        assert_eq!(result.application_message.unwrap(), msg);
    }

    #[test]
    fn voice_key_derivation() {
        let provider = Provider::new();
        let alice = Identity::new(&provider, "alice:device1").unwrap();
        let group = Group::create_new(&provider, &alice, "voice-group");

        let key = group
            .export_secret(&provider, "voice-e2ee", &[], 16)
            .unwrap();
        assert_eq!(key.len(), 16);
    }

    #[test]
    fn member_identities() {
        let alice_provider = Provider::new();
        let bob_provider = Provider::new();

        let alice = Identity::new(&alice_provider, "alice:device1").unwrap();
        let bob = Identity::new(&bob_provider, "bob:device1").unwrap();

        let mut group = Group::create_new(&alice_provider, &alice, "members-group");
        let bob_kp = bob.key_package(&bob_provider);

        let bundle = group.add_member(&alice_provider, &alice, &bob_kp).unwrap();
        group.merge_pending_commit(&alice_provider).unwrap();

        let identities_json = group.member_identities();
        let identities: Vec<String> = serde_json::from_str(&identities_json).unwrap();
        assert!(identities.contains(&"alice:device1".to_string()));
        assert!(identities.contains(&"bob:device1".to_string()));
    }
}

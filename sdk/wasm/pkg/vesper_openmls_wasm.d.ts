/* tslint:disable */
/* eslint-disable */

export class CommitBundle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly commit: Uint8Array;
    readonly group_info: Uint8Array | undefined;
    readonly welcome: Uint8Array | undefined;
}

export class ExternalCommitResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get the external commit bytes to fan out to existing members
     */
    commit_bytes(): Uint8Array;
    /**
     * Take the group (consumes this field)
     */
    take_group(): Group;
}

export class Group {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add a member to the group using inline add proposals.
     * The commit is self-contained — other members can process it without
     * having received a separate proposal first.
     */
    add_member(provider: Provider, sender: Identity, new_member: KeyPackage): CommitBundle;
    /**
     * Create an encrypted application message
     */
    create_message(provider: Provider, sender: Identity, msg: Uint8Array): Uint8Array;
    /**
     * Create a new MLS group. The founder is the first member.
     */
    static create_new(provider: Provider, founder: Identity, group_id: string): Group;
    /**
     * Get the current epoch number
     */
    epoch(): bigint;
    /**
     * Export GroupInfo for External Commit flow.
     * This should be published to the server after each epoch change.
     */
    export_group_info(provider: Provider, signer: Identity): Uint8Array;
    /**
     * Export the ratchet tree (needed for External Commit if not embedded in GroupInfo)
     */
    export_ratchet_tree(): RatchetTree;
    /**
     * Export a secret from the group's key schedule (e.g., for voice key derivation)
     */
    export_secret(provider: Provider, label: string, context: Uint8Array, key_length: number): Uint8Array;
    /**
     * Get the group ID as a string
     */
    group_id(): string;
    /**
     * Join a group via External Commit (RFC 9420 §12.4).
     *
     * This is the key feature: the new member adds themselves using
     * published GroupInfo. No existing member needs to be online.
     *
     * Returns the new Group and a CommitBundle containing the external
     * commit message that must be fanned out to other members.
     */
    static join_from_external_commit(provider: Provider, joiner: Identity, group_info_bytes: Uint8Array, ratchet_tree?: RatchetTree | null): ExternalCommitResult;
    /**
     * Join a group via Welcome message (traditional flow)
     */
    static join_from_welcome(provider: Provider, welcome_bytes: Uint8Array, ratchet_tree?: RatchetTree | null): Group;
    /**
     * Load a group from the provider's storage (after Provider.deserialize_storage()).
     */
    static load(provider: Provider, group_id: string): Group;
    /**
     * Get the number of members in the group
     */
    member_count(): number;
    /**
     * Get member identities as a JSON array of strings
     */
    member_identities(): string;
    /**
     * Get credential names and Ed25519 public keys for signature verification.
     */
    member_signing_identities(): string;
    /**
     * Merge a pending commit (after add/remove/external commit)
     */
    merge_pending_commit(provider: Provider): void;
    /**
     * Get the own leaf's credential identity name and signature public key.
     * Used after join_from_welcome to reconstruct the correct Identity
     * (instead of creating a fresh one with a mismatched keypair).
     */
    own_leaf_identity(): OwnLeafIdentity;
    /**
     * Process an incoming MLS message (commit, proposal, or application message)
     */
    process_message(provider: Provider, msg: Uint8Array): ProcessResult;
    /**
     * Remove a member by leaf index using inline remove proposals.
     */
    remove_member(provider: Provider, sender: Identity, leaf_index: number): CommitBundle;
    /**
     * Remove several members in one MLS commit.
     */
    remove_members(provider: Provider, sender: Identity, leaf_indices: Uint32Array): CommitBundle;
}

export class GroupInfo {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static from_bytes(bytes: Uint8Array): GroupInfo;
    to_bytes(): Uint8Array;
}

export class Identity {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Deserialize an identity from bytes.
     * The Provider must have had its storage restored first (via Provider.deserialize_storage()).
     * The signing keypair is read from the provider's storage using the stored public key.
     */
    static deserialize(provider: Provider, data: Uint8Array): Identity;
    /**
     * Generate a key package for this identity
     */
    key_package(provider: Provider): KeyPackage;
    /**
     * Get the identity name (e.g., "userId:deviceId")
     */
    name(): string;
    /**
     * Create a new identity with the given name.
     * The name format should be "userId:deviceId" to match Vesper's convention.
     */
    constructor(provider: Provider, name: string);
    /**
     * Serialize the identity to bytes for persistence.
     * Only stores the name and public key — the private key is in the Provider's storage.
     * Format: name_len(u32-be) name pub_key_len(u32-be) pub_key
     */
    serialize(): Uint8Array;
    /**
     * Sign a purpose-bound application payload with this MLS leaf identity.
     */
    sign(payload: Uint8Array): Uint8Array;
    /**
     * Get the raw Ed25519 signature public key bytes.
     * Used for registration (sent to server for identity verification).
     */
    signature_public_key(): Uint8Array;
}

export class KeyPackage {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Deserialize a KeyPackage from bytes
     */
    static from_bytes(bytes: Uint8Array): KeyPackage;
    /**
     * Serialize this KeyPackage to bytes
     */
    to_bytes(): Uint8Array;
}

export class OwnLeafIdentity {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The credential identity name from the own leaf node
     */
    readonly name: string;
    /**
     * The Ed25519 signature public key from the own leaf node
     */
    readonly signature_public_key: Uint8Array;
}

export class ProcessResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * "application", "commit", "proposal"
     */
    readonly kind: string;
    /**
     * The decrypted application message, if kind == "application"
     */
    readonly message: Uint8Array | undefined;
}

export class Provider {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Restore provider storage from previously serialized bytes.
     * After calling this, groups can be loaded with Group.load().
     */
    deserialize_storage(data: Uint8Array): void;
    constructor();
    /**
     * Serialize the provider's storage (all group state, keys, etc.) to bytes.
     * Used for persisting state across sessions.
     */
    serialize_storage(): Uint8Array;
}

export class RatchetTree {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static from_bytes(bytes: Uint8Array): RatchetTree;
    to_bytes(): Uint8Array;
}

/**
 * Verify a published MLS GroupInfo against its ratchet tree without joining the group.
 * Returns only identities authenticated by the verified public MLS state.
 */
export function verify_public_group_snapshot(group_info_bytes: Uint8Array, ratchet_tree_bytes: Uint8Array): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_commitbundle_free: (a: number, b: number) => void;
    readonly __wbg_externalcommitresult_free: (a: number, b: number) => void;
    readonly __wbg_group_free: (a: number, b: number) => void;
    readonly __wbg_groupinfo_free: (a: number, b: number) => void;
    readonly __wbg_identity_free: (a: number, b: number) => void;
    readonly __wbg_keypackage_free: (a: number, b: number) => void;
    readonly __wbg_ownleafidentity_free: (a: number, b: number) => void;
    readonly __wbg_processresult_free: (a: number, b: number) => void;
    readonly __wbg_provider_free: (a: number, b: number) => void;
    readonly __wbg_ratchettree_free: (a: number, b: number) => void;
    readonly commitbundle_commit: (a: number) => [number, number];
    readonly commitbundle_group_info: (a: number) => [number, number];
    readonly commitbundle_welcome: (a: number) => [number, number];
    readonly externalcommitresult_commit_bytes: (a: number) => [number, number];
    readonly externalcommitresult_take_group: (a: number) => number;
    readonly group_add_member: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly group_create_message: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly group_create_new: (a: number, b: number, c: number, d: number) => number;
    readonly group_epoch: (a: number) => bigint;
    readonly group_export_group_info: (a: number, b: number, c: number) => [number, number, number, number];
    readonly group_export_ratchet_tree: (a: number) => number;
    readonly group_export_secret: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly group_group_id: (a: number) => [number, number];
    readonly group_join_from_external_commit: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly group_join_from_welcome: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly group_load: (a: number, b: number, c: number) => [number, number, number];
    readonly group_member_count: (a: number) => number;
    readonly group_member_identities: (a: number) => [number, number];
    readonly group_member_signing_identities: (a: number) => [number, number];
    readonly group_merge_pending_commit: (a: number, b: number) => [number, number];
    readonly group_own_leaf_identity: (a: number) => [number, number, number];
    readonly group_process_message: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly group_remove_member: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly group_remove_members: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly groupinfo_from_bytes: (a: number, b: number) => number;
    readonly groupinfo_to_bytes: (a: number) => [number, number];
    readonly identity_deserialize: (a: number, b: number, c: number) => [number, number, number];
    readonly identity_key_package: (a: number, b: number) => number;
    readonly identity_name: (a: number) => [number, number];
    readonly identity_new: (a: number, b: number, c: number) => [number, number, number];
    readonly identity_serialize: (a: number) => [number, number];
    readonly identity_sign: (a: number, b: number, c: number) => [number, number, number, number];
    readonly identity_signature_public_key: (a: number) => [number, number];
    readonly keypackage_from_bytes: (a: number, b: number) => [number, number, number];
    readonly keypackage_to_bytes: (a: number) => [number, number];
    readonly ownleafidentity_name: (a: number) => [number, number];
    readonly ownleafidentity_signature_public_key: (a: number) => [number, number];
    readonly processresult_kind: (a: number) => [number, number];
    readonly processresult_message: (a: number) => [number, number];
    readonly provider_deserialize_storage: (a: number, b: number, c: number) => [number, number];
    readonly provider_new: () => number;
    readonly provider_serialize_storage: (a: number) => [number, number];
    readonly ratchettree_from_bytes: (a: number, b: number) => [number, number, number];
    readonly ratchettree_to_bytes: (a: number) => [number, number];
    readonly verify_public_group_snapshot: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

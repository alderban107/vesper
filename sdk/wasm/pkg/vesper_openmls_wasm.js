/* @ts-self-types="./vesper_openmls_wasm.d.ts" */

export class CommitBundle {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(CommitBundle.prototype);
        obj.__wbg_ptr = ptr;
        CommitBundleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CommitBundleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_commitbundle_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    get commit() {
        const ret = wasm.commitbundle_commit(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array | undefined}
     */
    get group_info() {
        const ret = wasm.commitbundle_group_info(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @returns {Uint8Array | undefined}
     */
    get welcome() {
        const ret = wasm.commitbundle_welcome(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
}
if (Symbol.dispose) CommitBundle.prototype[Symbol.dispose] = CommitBundle.prototype.free;

export class ExternalCommitResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ExternalCommitResult.prototype);
        obj.__wbg_ptr = ptr;
        ExternalCommitResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ExternalCommitResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_externalcommitresult_free(ptr, 0);
    }
    /**
     * Get the external commit bytes to fan out to existing members
     * @returns {Uint8Array}
     */
    commit_bytes() {
        const ret = wasm.externalcommitresult_commit_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Take the group (consumes this field)
     * @returns {Group}
     */
    take_group() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.externalcommitresult_take_group(ptr);
        return Group.__wrap(ret);
    }
}
if (Symbol.dispose) ExternalCommitResult.prototype[Symbol.dispose] = ExternalCommitResult.prototype.free;

export class Group {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Group.prototype);
        obj.__wbg_ptr = ptr;
        GroupFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GroupFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_group_free(ptr, 0);
    }
    /**
     * Add a member to the group using inline add proposals.
     * The commit is self-contained — other members can process it without
     * having received a separate proposal first.
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {KeyPackage} new_member
     * @returns {CommitBundle}
     */
    add_member(provider, sender, new_member) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        _assertClass(new_member, KeyPackage);
        const ret = wasm.group_add_member(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, new_member.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CommitBundle.__wrap(ret[0]);
    }
    /**
     * Create an encrypted application message
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {Uint8Array} msg
     * @returns {Uint8Array}
     */
    create_message(provider, sender, msg) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ptr0 = passArray8ToWasm0(msg, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_create_message(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * Create a new MLS group. The founder is the first member.
     * @param {Provider} provider
     * @param {Identity} founder
     * @param {string} group_id
     * @returns {Group}
     */
    static create_new(provider, founder, group_id) {
        _assertClass(provider, Provider);
        _assertClass(founder, Identity);
        const ptr0 = passStringToWasm0(group_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_create_new(provider.__wbg_ptr, founder.__wbg_ptr, ptr0, len0);
        return Group.__wrap(ret);
    }
    /**
     * Get the current epoch number
     * @returns {bigint}
     */
    epoch() {
        const ret = wasm.group_epoch(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Export GroupInfo for External Commit flow.
     * This should be published to the server after each epoch change.
     * @param {Provider} provider
     * @param {Identity} signer
     * @returns {Uint8Array}
     */
    export_group_info(provider, signer) {
        _assertClass(provider, Provider);
        _assertClass(signer, Identity);
        const ret = wasm.group_export_group_info(this.__wbg_ptr, provider.__wbg_ptr, signer.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Export the ratchet tree (needed for External Commit if not embedded in GroupInfo)
     * @returns {RatchetTree}
     */
    export_ratchet_tree() {
        const ret = wasm.group_export_ratchet_tree(this.__wbg_ptr);
        return RatchetTree.__wrap(ret);
    }
    /**
     * Export a secret from the group's key schedule (e.g., for voice key derivation)
     * @param {Provider} provider
     * @param {string} label
     * @param {Uint8Array} context
     * @param {number} key_length
     * @returns {Uint8Array}
     */
    export_secret(provider, label, context, key_length) {
        _assertClass(provider, Provider);
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(context, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.group_export_secret(this.__wbg_ptr, provider.__wbg_ptr, ptr0, len0, ptr1, len1, key_length);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v3;
    }
    /**
     * Get the group ID as a string
     * @returns {string}
     */
    group_id() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.group_group_id(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Join a group via External Commit (RFC 9420 §12.4).
     *
     * This is the key feature: the new member adds themselves using
     * published GroupInfo. No existing member needs to be online.
     *
     * Returns the new Group and a CommitBundle containing the external
     * commit message that must be fanned out to other members.
     * @param {Provider} provider
     * @param {Identity} joiner
     * @param {Uint8Array} group_info_bytes
     * @param {RatchetTree | null} [ratchet_tree]
     * @returns {ExternalCommitResult}
     */
    static join_from_external_commit(provider, joiner, group_info_bytes, ratchet_tree) {
        _assertClass(provider, Provider);
        _assertClass(joiner, Identity);
        const ptr0 = passArray8ToWasm0(group_info_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        let ptr1 = 0;
        if (!isLikeNone(ratchet_tree)) {
            _assertClass(ratchet_tree, RatchetTree);
            ptr1 = ratchet_tree.__destroy_into_raw();
        }
        const ret = wasm.group_join_from_external_commit(provider.__wbg_ptr, joiner.__wbg_ptr, ptr0, len0, ptr1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ExternalCommitResult.__wrap(ret[0]);
    }
    /**
     * Join a group via Welcome message (traditional flow)
     * @param {Provider} provider
     * @param {Uint8Array} welcome_bytes
     * @param {RatchetTree | null} [ratchet_tree]
     * @returns {Group}
     */
    static join_from_welcome(provider, welcome_bytes, ratchet_tree) {
        _assertClass(provider, Provider);
        const ptr0 = passArray8ToWasm0(welcome_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        let ptr1 = 0;
        if (!isLikeNone(ratchet_tree)) {
            _assertClass(ratchet_tree, RatchetTree);
            ptr1 = ratchet_tree.__destroy_into_raw();
        }
        const ret = wasm.group_join_from_welcome(provider.__wbg_ptr, ptr0, len0, ptr1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Group.__wrap(ret[0]);
    }
    /**
     * Load a group from the provider's storage (after Provider.deserialize_storage()).
     * @param {Provider} provider
     * @param {string} group_id
     * @returns {Group}
     */
    static load(provider, group_id) {
        _assertClass(provider, Provider);
        const ptr0 = passStringToWasm0(group_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_load(provider.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Group.__wrap(ret[0]);
    }
    /**
     * Get the number of members in the group
     * @returns {number}
     */
    member_count() {
        const ret = wasm.group_member_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get member identities as a JSON array of strings
     * @returns {string}
     */
    member_identities() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.group_member_identities(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Merge a pending commit (after add/remove/external commit)
     * @param {Provider} provider
     */
    merge_pending_commit(provider) {
        _assertClass(provider, Provider);
        const ret = wasm.group_merge_pending_commit(this.__wbg_ptr, provider.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Get the own leaf's credential identity name and signature public key.
     * Used after join_from_welcome to reconstruct the correct Identity
     * (instead of creating a fresh one with a mismatched keypair).
     * @returns {OwnLeafIdentity}
     */
    own_leaf_identity() {
        const ret = wasm.group_own_leaf_identity(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return OwnLeafIdentity.__wrap(ret[0]);
    }
    /**
     * Process an incoming MLS message (commit, proposal, or application message)
     * @param {Provider} provider
     * @param {Uint8Array} msg
     * @returns {ProcessResult}
     */
    process_message(provider, msg) {
        _assertClass(provider, Provider);
        const ptr0 = passArray8ToWasm0(msg, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_process_message(this.__wbg_ptr, provider.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProcessResult.__wrap(ret[0]);
    }
    /**
     * Remove a member by leaf index using inline remove proposals.
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {number} leaf_index
     * @returns {CommitBundle}
     */
    remove_member(provider, sender, leaf_index) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ret = wasm.group_remove_member(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, leaf_index);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CommitBundle.__wrap(ret[0]);
    }
}
if (Symbol.dispose) Group.prototype[Symbol.dispose] = Group.prototype.free;

export class GroupInfo {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(GroupInfo.prototype);
        obj.__wbg_ptr = ptr;
        GroupInfoFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GroupInfoFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_groupinfo_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} bytes
     * @returns {GroupInfo}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.groupinfo_from_bytes(ptr0, len0);
        return GroupInfo.__wrap(ret);
    }
    /**
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.groupinfo_to_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) GroupInfo.prototype[Symbol.dispose] = GroupInfo.prototype.free;

export class Identity {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Identity.prototype);
        obj.__wbg_ptr = ptr;
        IdentityFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IdentityFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_identity_free(ptr, 0);
    }
    /**
     * Deserialize an identity from bytes.
     * The Provider must have had its storage restored first (via Provider.deserialize_storage()).
     * The signing keypair is read from the provider's storage using the stored public key.
     * @param {Provider} provider
     * @param {Uint8Array} data
     * @returns {Identity}
     */
    static deserialize(provider, data) {
        _assertClass(provider, Provider);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.identity_deserialize(provider.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Identity.__wrap(ret[0]);
    }
    /**
     * Generate a key package for this identity
     * @param {Provider} provider
     * @returns {KeyPackage}
     */
    key_package(provider) {
        _assertClass(provider, Provider);
        const ret = wasm.identity_key_package(this.__wbg_ptr, provider.__wbg_ptr);
        return KeyPackage.__wrap(ret);
    }
    /**
     * Get the identity name (e.g., "userId:deviceId")
     * @returns {string}
     */
    name() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.identity_name(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Create a new identity with the given name.
     * The name format should be "userId:deviceId" to match Vesper's convention.
     * @param {Provider} provider
     * @param {string} name
     */
    constructor(provider, name) {
        _assertClass(provider, Provider);
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.identity_new(provider.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        IdentityFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Serialize the identity to bytes for persistence.
     * Only stores the name and public key — the private key is in the Provider's storage.
     * Format: name_len(u32-be) name pub_key_len(u32-be) pub_key
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.identity_serialize(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Get the raw Ed25519 signature public key bytes.
     * Used for registration (sent to server for identity verification).
     * @returns {Uint8Array}
     */
    signature_public_key() {
        const ret = wasm.identity_signature_public_key(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) Identity.prototype[Symbol.dispose] = Identity.prototype.free;

export class KeyPackage {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(KeyPackage.prototype);
        obj.__wbg_ptr = ptr;
        KeyPackageFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        KeyPackageFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_keypackage_free(ptr, 0);
    }
    /**
     * Deserialize a KeyPackage from bytes
     * @param {Uint8Array} bytes
     * @returns {KeyPackage}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.keypackage_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return KeyPackage.__wrap(ret[0]);
    }
    /**
     * Serialize this KeyPackage to bytes
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.keypackage_to_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) KeyPackage.prototype[Symbol.dispose] = KeyPackage.prototype.free;

export class OwnLeafIdentity {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(OwnLeafIdentity.prototype);
        obj.__wbg_ptr = ptr;
        OwnLeafIdentityFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        OwnLeafIdentityFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ownleafidentity_free(ptr, 0);
    }
    /**
     * The credential identity name from the own leaf node
     * @returns {string}
     */
    get name() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.ownleafidentity_name(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The Ed25519 signature public key from the own leaf node
     * @returns {Uint8Array}
     */
    get signature_public_key() {
        const ret = wasm.ownleafidentity_signature_public_key(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) OwnLeafIdentity.prototype[Symbol.dispose] = OwnLeafIdentity.prototype.free;

export class ProcessResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ProcessResult.prototype);
        obj.__wbg_ptr = ptr;
        ProcessResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProcessResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_processresult_free(ptr, 0);
    }
    /**
     * "application", "commit", "proposal"
     * @returns {string}
     */
    get kind() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.processresult_kind(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The decrypted application message, if kind == "application"
     * @returns {Uint8Array | undefined}
     */
    get message() {
        const ret = wasm.processresult_message(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
}
if (Symbol.dispose) ProcessResult.prototype[Symbol.dispose] = ProcessResult.prototype.free;

export class Provider {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProviderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_provider_free(ptr, 0);
    }
    /**
     * Restore provider storage from previously serialized bytes.
     * After calling this, groups can be loaded with Group.load().
     * @param {Uint8Array} data
     */
    deserialize_storage(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.provider_deserialize_storage(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    constructor() {
        const ret = wasm.provider_new();
        this.__wbg_ptr = ret >>> 0;
        ProviderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Serialize the provider's storage (all group state, keys, etc.) to bytes.
     * Used for persisting state across sessions.
     * @returns {Uint8Array}
     */
    serialize_storage() {
        const ret = wasm.provider_serialize_storage(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) Provider.prototype[Symbol.dispose] = Provider.prototype.free;

export class RatchetTree {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(RatchetTree.prototype);
        obj.__wbg_ptr = ptr;
        RatchetTreeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RatchetTreeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ratchettree_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} bytes
     * @returns {RatchetTree}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ratchettree_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RatchetTree.__wrap(ret[0]);
    }
    /**
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.ratchettree_to_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) RatchetTree.prototype[Symbol.dispose] = RatchetTree.prototype.free;

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_83742b46f01ce22d: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_is_function_3c846841762788c1: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_781bc9f159099513: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_7ef6b97b02428fae: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_52709e72fb9f179c: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_6ddd609b62940d55: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_2d781c1f4d5c0ef8: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_length_ea16607d7b61445b: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_with_length_825018a1616e9e55: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_now_16f0c993d5dd6c27: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_d62e5099504357e6: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_8adb955bd33fac2f: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_ad356e0db91c7913: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_f207c857566db248: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_bb9f1ba69d61b386: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_a068d24e39478a8a: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./vesper_openmls_wasm_bg.js": import0,
    };
}

const CommitBundleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_commitbundle_free(ptr >>> 0, 1));
const ExternalCommitResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_externalcommitresult_free(ptr >>> 0, 1));
const GroupFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_group_free(ptr >>> 0, 1));
const GroupInfoFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_groupinfo_free(ptr >>> 0, 1));
const IdentityFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_identity_free(ptr >>> 0, 1));
const KeyPackageFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_keypackage_free(ptr >>> 0, 1));
const OwnLeafIdentityFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ownleafidentity_free(ptr >>> 0, 1));
const ProcessResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_processresult_free(ptr >>> 0, 1));
const ProviderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_provider_free(ptr >>> 0, 1));
const RatchetTreeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ratchettree_free(ptr >>> 0, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('vesper_openmls_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };

/**
 * In-memory mocks for window.cryptoDb, window.electron, and window.notifications.
 * Injected via page.addInitScript() before any app code runs.
 *
 * These must be serializable — no imports, no closures over external modules.
 */
export function getMockScript(): string {
  return `
    (() => {
      // --- CryptoDb in-memory store ---
      const identityStore = new Map();
      const groupStore = new Map();
      const keyPackages = [];
      let kpIdCounter = 1;
      const messageCache = new Map(); // channelId -> messages[]

      window.cryptoDb = {
        // Identity keys
        async getIdentityKeys(userId) {
          return identityStore.get(userId) || null;
        },
        async setIdentityKeys(userId, publicIdentityKey, publicKeyExchange, encryptedPrivateKeys, nonce, salt) {
          identityStore.set(userId, {
            public_identity_key: publicIdentityKey.buffer,
            public_key_exchange: publicKeyExchange.buffer,
            encrypted_private_keys: encryptedPrivateKeys.buffer,
            nonce: nonce.buffer,
            salt: salt.buffer,
          });
        },
        async deleteIdentityKeys(userId) {
          identityStore.delete(userId);
        },

        // MLS groups
        async getGroupState(groupId) {
          return groupStore.get(groupId) || null;
        },
        async setGroupState(groupId, state, epoch) {
          groupStore.set(groupId, { state: state.buffer, epoch });
        },
        async deleteGroupState(groupId) {
          groupStore.delete(groupId);
        },

        // Key packages
        async getLocalKeyPackages() {
          return keyPackages.map(kp => ({
            id: kp.id,
            key_package_public: kp.publicData.buffer,
            key_package_private: kp.privateData.buffer,
          }));
        },
        async setLocalKeyPackages(packages) {
          for (const pkg of packages) {
            keyPackages.push({
              id: kpIdCounter++,
              publicData: pkg.publicData,
              privateData: pkg.privateData,
            });
          }
        },
        async consumeLocalKeyPackage(id) {
          const idx = keyPackages.findIndex(kp => kp.id === id);
          if (idx !== -1) keyPackages.splice(idx, 1);
        },
        async countLocalKeyPackages() {
          return keyPackages.length;
        },

        // Message cache
        async cacheMessage(msg) {
          if (!messageCache.has(msg.channel_id)) {
            messageCache.set(msg.channel_id, []);
          }
          messageCache.get(msg.channel_id).push(msg);
        },
        async getCachedMessages(channelId) {
          return messageCache.get(channelId) || [];
        },
        async clearMessageCache(channelId) {
          messageCache.delete(channelId);
        },
      };

      // --- searchMessages (used by SearchBar) ---
      window.searchMessages = async function(query) {
        const results = [];
        for (const [, msgs] of messageCache) {
          for (const msg of msgs) {
            if (msg.content && msg.content.toLowerCase().includes(query.toLowerCase())) {
              results.push(msg);
            }
          }
        }
        return results;
      };

      // --- Electron IPC mock ---
      const ipcListeners = new Map();
      window.electron = {
        ipcRenderer: {
          async invoke(channel, ...args) {
            // Return sensible defaults for known channels
            if (channel === 'voice:showCallNotification') return undefined;
            return undefined;
          },
          send(channel, ...args) {
            // noop
          },
          on(channel, listener) {
            if (!ipcListeners.has(channel)) {
              ipcListeners.set(channel, []);
            }
            ipcListeners.get(channel).push(listener);
            return () => {
              const listeners = ipcListeners.get(channel);
              if (listeners) {
                const idx = listeners.indexOf(listener);
                if (idx !== -1) listeners.splice(idx, 1);
              }
            };
          },
        },
      };

      // --- Notifications mock ---
      window.notifications = {
        show(title, body) {
          // noop in tests
        },
        requestPermission() {
          return Promise.resolve('granted');
        },
      };
    })();
  `
}

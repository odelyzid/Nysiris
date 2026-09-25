/**
 * Keystore-backed secret storage for nysiris.
 *
 * Browser storage (localStorage / IndexedDB) is app-scoped, not
 * hardware-backed: any script in the origin (XSS, malicious extension with
 * host permissions) can read it. On Android the same web code can instead
 * store secrets in the hardware-backed Android Keystore via the
 * `NysirisKeystore` Capacitor plugin
 * (`web/android/app/src/main/java/app/example/nysiris/NysirisKeystorePlugin.java`),
 * which holds AES-GCM keys inside the Keystore and only returns ciphertext
 * handles to the WebView.
 *
 * This module is the JS side of that contract. It is dependency-free (no
 * `@capacitor/core` import, so `node --test web/test` and the offline
 * `./build.sh check` loop keep working): the plugin is detected structurally
 * on `globalThis.Capacitor.Plugins.NysirisKeystore` and every operation
 * degrades gracefully, letting callers fall back to the localStorage cache
 * in `identity.ts`.
 *
 * Key names are namespaced (`nysiris/<name>`) so the plugin store never
 * collides with other apps or plugins sharing the Keystore.
 *
 * Kept free of browser globals so `node --test web/test` can verify it.
 */

/**
 * @typedef {object} KeystorePlugin
 * @property {(options: { key: string }) => Promise<{ value: string }>} get
 * @property {(options: { key: string, value: string }) => Promise<void>} set
 * @property {(options: { key: string }) => Promise<void>} remove
 */

/**
 * @returns {KeystorePlugin | null}
 */
function detectPlugin() {
  try {
    const cap = /** @type {{ Capacitor?: { Plugins?: Record<string, unknown> } }} */ (globalThis).Capacitor;
    const plugin = cap?.Plugins?.NysirisKeystore;
    if (
      plugin !== null &&
      typeof plugin === 'object' &&
      typeof (/** @type {KeystorePlugin} */ (plugin).get) === 'function' &&
      typeof (/** @type {KeystorePlugin} */ (plugin).set) === 'function' &&
      typeof (/** @type {KeystorePlugin} */ (plugin).remove) === 'function'
    ) {
      return /** @type {KeystorePlugin} */ (plugin);
    }
  } catch {
    // No Capacitor runtime (desktop browser, tests, workers).
  }
  return null;
}

/** True when a hardware-backed keystore plugin is reachable. */
export function isKeystoreAvailable() {
  return detectPlugin() !== null;
}

const NAMESPACE = 'nysiris/';

/**
 * @param {string} name
 * @returns {string}
 */
function namespaced(name) {
  if (!name) throw new Error('keystore key name must not be empty');
  return `${NAMESPACE}${name}`;
}

/**
 * Load a base64 secret from the keystore. Null when absent *or* unavailable.
 *
 * @param {string} name
 * @returns {Promise<string | null>}
 */
export async function keystoreGet(name) {
  const plugin = detectPlugin();
  if (!plugin) return null;
  const key = namespaced(name);
  try {
    const { value } = await plugin.get({ key });
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Store a base64 secret in the keystore.
 *
 * @param {string} name
 * @param {string} valueB64
 * @returns {Promise<{ available: boolean }>} `{ available: false }` when no plugin
 */
export async function keystoreSet(name, valueB64) {
  const plugin = detectPlugin();
  if (!plugin) return { available: false };
  await plugin.set({ key: namespaced(name), value: valueB64 });
  return { available: true };
}

/**
 * Remove a secret from the keystore. Absent keys and missing plugins both
 * succeed quietly.
 *
 * @param {string} name
 * @returns {Promise<{ available: boolean }>}
 */
export async function keystoreRemove(name) {
  const plugin = detectPlugin();
  if (!plugin) return { available: false };
  const key = namespaced(name);
  try {
    await plugin.remove({ key });
  } catch {
    // Absent key: nothing to do.
  }
  return { available: true };
}

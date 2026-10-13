/**
 * Foreground-service keep-alive for the Android shell.
 *
 * While the app is backgrounded, Android Doze / App Standby freeze the process
 * and would suspend the one-shot mixnet tunnel running in the WebView. A
 * foreground service with an ongoing notification keeps the process alive; this
 * module is the JS side that starts and stops it.
 *
 * Dependency-free (no `@capacitor/core` import, so `node --test web/test` and
 * the offline `./build.sh check` loop keep working): the plugin is detected
 * structurally on `globalThis.Capacitor.Plugins.NysirisForeground` and every
 * call degrades gracefully on desktop / tests / workers.
 *
 * Native: web/android/app/src/main/java/com/tribewarez/nysiris/
 * `NysirisForegroundService.java` and `NysirisForegroundPlugin.java`.
 */

/**
 * @typedef {object} ForegroundPlugin
 * @property {() => Promise<{ running?: boolean }>} start
 * @property {() => Promise<{ running?: boolean }>} stop
 */

/**
 * @returns {ForegroundPlugin | null}
 */
function detectPlugin() {
  try {
    const cap =
      /** @type {{ Capacitor?: { Plugins?: Record<string, unknown> } }} */ (globalThis).Capacitor;
    const plugin = cap?.Plugins?.NysirisForeground;
    if (
      plugin !== null &&
      typeof plugin === 'object' &&
      typeof (/** @type {ForegroundPlugin} */ (plugin).start) === 'function' &&
      typeof (/** @type {ForegroundPlugin} */ (plugin).stop) === 'function'
    ) {
      return /** @type {ForegroundPlugin} */ (plugin);
    }
  } catch {
    // No Capacitor runtime (desktop browser, tests, workers).
  }
  return null;
}

/** True when the Android foreground-service plugin is reachable. */
export function isForegroundAvailable() {
  return detectPlugin() !== null;
}

/**
 * Start the keep-alive foreground service. On non-Android platforms
 * `available` is false and nothing happens.
 *
 * @returns {Promise<{ available: boolean, running: boolean }>}
 */
export async function startForeground() {
  const plugin = detectPlugin();
  if (!plugin) return { available: false, running: false };
  try {
    const result = await plugin.start();
    return { available: true, running: result?.running !== false };
  } catch {
    return { available: true, running: false };
  }
}

/** Stop the keep-alive foreground service. Best-effort; never throws. */
export async function stopForeground() {
  const plugin = detectPlugin();
  if (!plugin) return;
  try {
    await plugin.stop();
  } catch {
    // Nothing to stop.
  }
}

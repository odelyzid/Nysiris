package app.example.nysiris;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.content.Context;
import android.os.Build;
import android.util.Base64;

import javax.crypto.SecretKey;

/**
 * Hardware-backed secret storage for the nysiris WebView.
 *
 * <p>JS contract: {@code web/src/adapters/driven/keystore.mjs} (values are
 * base64 bytes in both directions; identity persistence in
 * {@code web/src/application/identityStore.ts}). AES-256-GCM keys are
 * generated and held inside the Android Keystore (hardware-backed on devices
 * with StrongBox / TEE); only ciphertext blobs are kept in SharedPreferences,
 * so a WebView compromise or a backup dump never exposes plaintext. Requires
 * API 23+ (AES/GCM in the Keystore); older devices get a clean "unavailable"
 * rejection and the JS layer falls back to its localStorage cache.
 *
 * <p>Crypto framing lives in {@link KeystoreCrypto} (unit-tested on the host
 * JVM and on device); this class is only the Capacitor glue. Registered in
 * {@link MainActivity}.
 */
@CapacitorPlugin(name = "NysirisKeystore")
public class NysirisKeystorePlugin extends Plugin {

    private static final String PREFS = "nysiris_keystore";
    private static final String KEY_ALIAS_PREFIX = "nysiris/";

    private static String aliasFor(String key) {
        return KEY_ALIAS_PREFIX + key;
    }

    /** False (after rejecting) when the Keystore AES/GCM path is unavailable. */
    private boolean requireApi23(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            call.reject("unavailable: Android Keystore AES/GCM requires API 23+");
            return false;
        }
        return true;
    }

    private boolean requireKey(PluginCall call, String key) {
        if (key == null || key.isEmpty()) {
            call.reject("key must not be empty");
            return false;
        }
        return true;
    }

    private android.content.SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void get(PluginCall call) {
        if (!requireApi23(call)) {
            return;
        }
        String key = call.getString("key");
        if (!requireKey(call, key)) {
            return;
        }
        try {
            String stored = prefs().getString(key, null);
            if (stored == null) {
                call.reject("not found");
                return;
            }
            SecretKey sk = KeystoreCrypto.getOrCreateKeystoreKey(aliasFor(key));
            byte[] plain = KeystoreCrypto.decryptFromBlob(sk, Base64.decode(stored, Base64.DEFAULT));
            JSObject ret = new JSObject();
            ret.put("value", Base64.encodeToString(plain, Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("keystore get failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        if (!requireApi23(call)) {
            return;
        }
        String key = call.getString("key");
        if (!requireKey(call, key)) {
            return;
        }
        String value = call.getString("value");
        if (value == null) {
            call.reject("value must not be null");
            return;
        }
        try {
            SecretKey sk = KeystoreCrypto.getOrCreateKeystoreKey(aliasFor(key));
            byte[] blob = KeystoreCrypto.encryptToBlob(sk, Base64.decode(value, Base64.DEFAULT));
            // Only ciphertext ever touches SharedPreferences; the key itself
            // never leaves the Keystore.
            prefs().edit().putString(key, Base64.encodeToString(blob, Base64.NO_WRAP)).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("keystore set failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (!requireKey(call, key)) {
            return;
        }
        try {
            prefs().edit().remove(key).apply();
            // Keep the Keystore alias: re-creating it would orphan any backup
            // of the ciphertext, and aliases are cheap.
            call.resolve();
        } catch (Exception e) {
            call.reject("keystore remove failed: " + e.getMessage());
        }
    }
}

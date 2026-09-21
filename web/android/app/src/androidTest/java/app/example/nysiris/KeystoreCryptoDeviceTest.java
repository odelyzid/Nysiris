package app.example.nysiris;

import static org.junit.Assert.*;

import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import javax.crypto.SecretKey;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * On-device smoke test for the hardware-backed keystore path. Runs on an
 * emulator (or physical device) via {@code connectedAndroidTest}: provisions
 * real Android Keystore keys and round-trips the exact envelope the
 * {@code NysirisKeystore} plugin stores in SharedPreferences.
 */
@RunWith(AndroidJUnit4.class)
public class KeystoreCryptoDeviceTest {

    private static final String ALIAS = "nysiris/smoke-test";

    @Test
    public void keystoreRoundTripOnDevice() throws Exception {
        SecretKey key = KeystoreCrypto.getOrCreateKeystoreKey(ALIAS);
        assertNotNull("Keystore must provision an AES key", key);

        byte[] plain = "device-keystore-smoke".getBytes("UTF-8");
        byte[] blob = KeystoreCrypto.encryptToBlob(key, plain);

        // What lands in SharedPreferences is ciphertext, never plaintext.
        String stored = Base64.encodeToString(blob, Base64.NO_WRAP);
        assertFalse(stored.contains("device-keystore-smoke"));

        // A second provision of the same alias yields the same key: the
        // secret survives process restarts (it lives in the Keystore, not RAM).
        SecretKey again = KeystoreCrypto.getOrCreateKeystoreKey(ALIAS);
        assertArrayEquals(plain, KeystoreCrypto.decryptFromBlob(again, blob));
    }

    @Test
    public void deviceRejectsTamperedBlob() throws Exception {
        SecretKey key = KeystoreCrypto.getOrCreateKeystoreKey(ALIAS);
        byte[] blob = KeystoreCrypto.encryptToBlob(key, "tamper-me".getBytes("UTF-8"));
        blob[12] ^= 0x40;
        try {
            KeystoreCrypto.decryptFromBlob(key, blob);
            fail("tampered blob must not decrypt on device");
        } catch (Exception expected) {
        }
    }
}

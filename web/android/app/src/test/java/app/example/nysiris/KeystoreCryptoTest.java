package app.example.nysiris;

import static org.junit.Assert.*;

import java.util.Arrays;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.junit.Test;

/**
 * Host-JVM unit tests for {@link KeystoreCrypto} framing. Keys here are
 * software AES keys (the Android Keystore is unavailable on the host); the
 * on-device twin is {@code KeystoreCryptoDeviceTest}, which provisions real
 * Keystore keys on an emulator.
 */
public class KeystoreCryptoTest {

    private static SecretKey softwareKey() throws Exception {
        KeyGenerator gen = KeyGenerator.getInstance("AES");
        gen.init(256);
        return gen.generateKey();
    }

    @Test
    public void roundTrip() throws Exception {
        SecretKey key = softwareKey();
        byte[] plain = "social-identity-secret".getBytes("UTF-8");
        assertArrayEquals(plain, KeystoreCrypto.decryptFromBlob(key, KeystoreCrypto.encryptToBlob(key, plain)));
    }

    @Test
    public void encryptionIsRandomised() throws Exception {
        SecretKey key = softwareKey();
        byte[] plain = "same-plaintext".getBytes("UTF-8");
        byte[] a = KeystoreCrypto.encryptToBlob(key, plain);
        byte[] b = KeystoreCrypto.encryptToBlob(key, plain);
        assertFalse("identical plaintexts must never produce identical blobs", Arrays.equals(a, b));
    }

    @Test
    public void tamperedBlobFails() throws Exception {
        SecretKey key = softwareKey();
        byte[] blob = KeystoreCrypto.encryptToBlob(key, "tamper-me".getBytes("UTF-8"));
        blob[blob.length - 1] ^= 0x01;
        try {
            KeystoreCrypto.decryptFromBlob(key, blob);
            fail("flipped bit must break the GCM tag");
        } catch (Exception expected) {
            // AEADBadTagException (or provider equivalent): no partial plaintext.
        }
    }

    @Test
    public void wrongKeyFails() throws Exception {
        byte[] blob = KeystoreCrypto.encryptToBlob(softwareKey(), "secret".getBytes("UTF-8"));
        try {
            KeystoreCrypto.decryptFromBlob(softwareKey(), blob);
            fail("decryption under a different key must fail");
        } catch (Exception expected) {
        }
    }

    @Test
    public void truncatedBlobFailsFast() throws Exception {
        SecretKey key = softwareKey();
        try {
            KeystoreCrypto.decryptFromBlob(key, new byte[4]);
            fail("short blob must be rejected before touching the cipher");
        } catch (IllegalArgumentException expected) {
        }
    }
}

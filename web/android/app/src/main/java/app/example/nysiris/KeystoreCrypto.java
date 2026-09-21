package app.example.nysiris;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.nio.ByteBuffer;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * AES-256-GCM envelope for the {@code NysirisKeystore} plugin.
 *
 * <p>Deliberately free of Capacitor and Context dependencies so the framing
 * logic is unit-testable on the host JVM ({@code KeystoreCryptoTest}) while
 * key provisioning runs against the real Android Keystore on device
 * ({@code KeystoreCryptoDeviceTest}).
 *
 * <p>Blob layout: {@code nonce(12) || ciphertext+tag}. Nonces come from the
 * cipher itself ({@code getIV()}), so every encryption is randomised and
 * identical plaintexts never produce identical blobs.
 */
public final class KeystoreCrypto {

    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    private static final int NONCE_BYTES = 12;

    private KeystoreCrypto() {}

    /** Fetch the AES key for {@code alias}, generating it inside the Keystore on first use. */
    public static synchronized SecretKey getOrCreateKeystoreKey(String alias) throws Exception {
        KeyStore store = KeyStore.getInstance(ANDROID_KEYSTORE);
        store.load(null);
        if (store.containsAlias(alias)) {
            return (SecretKey) store.getKey(alias, null);
        }
        KeyGenerator gen = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        gen.init(new KeyGenParameterSpec.Builder(
                        alias,
                        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build());
        return gen.generateKey();
    }

    /** Encrypt {@code plain} to a {@code nonce || ciphertext} blob. */
    public static byte[] encryptToBlob(SecretKey key, byte[] plain) throws Exception {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] nonce = cipher.getIV();
        byte[] ct = cipher.doFinal(plain);
        ByteBuffer blob = ByteBuffer.allocate(nonce.length + ct.length);
        blob.put(nonce);
        blob.put(ct);
        return blob.array();
    }

    /**
     * Decrypt a blob. Throws on truncation, tampering, or a wrong key —
     * callers must treat every exception as "unreadable", never as partial
     * plaintext.
     */
    public static byte[] decryptFromBlob(SecretKey key, byte[] blob) throws Exception {
        if (blob == null || blob.length <= NONCE_BYTES) {
            throw new IllegalArgumentException("keystore blob too short");
        }
        ByteBuffer buf = ByteBuffer.wrap(blob);
        byte[] nonce = new byte[NONCE_BYTES];
        buf.get(nonce);
        byte[] ct = new byte[buf.remaining()];
        buf.get(ct);
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, nonce));
        return cipher.doFinal(ct);
    }
}

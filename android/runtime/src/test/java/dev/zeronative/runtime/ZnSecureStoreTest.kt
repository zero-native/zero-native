package dev.zeronative.runtime

import dev.zeronative.runtime.ZnSecureStore.Rules
import java.io.FileNotFoundException
import java.io.IOException
import java.security.InvalidKeyException
import java.security.KeyStoreException
import java.security.ProviderException
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * When SecureStore deletes a value (ZnSecureStore.Rules, old-phone audit 2026-11-06). Only an error that means "this
 * can never be read again" deletes; anything else keeps the value, because an app that reads "no token" as "logged
 * out" signs the user out and wipes their data. (Android 13+'s own Keystore codes aren't reachable from a JVM test.)
 */
class ZnSecureStoreTest {
    @Test fun dataThatDoesNotMatchTheKeyIsLost() {
        assertTrue(Rules.lostForGood(AEADBadTagException("mac check in GCM failed")))
    }

    @Test fun aBrokenOrMissingKeyIsLost() {
        assertTrue(Rules.lostForGood(UnrecoverableKeyException("Failed to obtain information about key")))
        assertTrue(Rules.lostForGood(ZnSecureStore.NoKey()))
    }

    @Test fun aDamagedFileIsLost() {
        assertTrue(Rules.lostForGood(ZnSecureStore.Damaged("bad IV")))
    }

    @Test fun aBusyKeystoreKeepsTheValue() {
        // Seen on some Android 7-9 phones: "Keystore operation failed". Before, any such error deleted the value.
        assertFalse(Rules.lostForGood(ProviderException("Keystore operation failed")))
        assertFalse(Rules.lostForGood(KeyStoreException("System error")))
        assertFalse(Rules.lostForGood(InvalidKeyException("Keystore operation failed", ProviderException("busy"))))
        assertFalse(Rules.lostForGood(IllegalStateException("Keystore not initialized")))
    }

    @Test fun aFileThatCantBeReadNowKeepsTheValue() {
        assertFalse(Rules.lostForGood(IOException("EIO")))
        assertFalse(Rules.lostForGood(FileNotFoundException("Permission denied")))
    }

    @Test fun onlyKnownPassingErrorsSkipMakingANewKey() {
        assertTrue(Rules.passes(ProviderException("Keystore operation failed")))
        assertTrue(Rules.passes(IOException("No space left on device")))
        // An error that keeps coming back on save (a key broken by an OS update): a new key is made, as before
        assertFalse(Rules.passes(InvalidKeyException("Keystore operation failed")))
        assertFalse(Rules.passes(UnrecoverableKeyException("Failed to obtain information about key")))
    }
}

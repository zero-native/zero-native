package dev.zeronative.plugins.firebase

import org.junit.Assert.assertEquals
import org.junit.Test

class FirebaseRulesTest {
    @Test fun `token expiry is given to JS in ms`() {
        assertEquals(1_700_000_000_000L, FirebaseRules.expiresAtMs(1_700_000_000L))
    }
}

package dev.zeronative.runtime

import dev.zeronative.runtime.ZnPermissions.Rules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a permission's state is (ZnPermissions.Rules): Android alone can't say "blocked". */
class ZnPermissionsTest {
    @Test fun grantedWinsOverEverything() {
        assertEquals("granted", Rules.state(granted = true, asked = true, rationale = false))
    }

    @Test fun neverAskedIsDenied() {
        assertEquals("denied", Rules.state(granted = false, asked = false, rationale = false))
    }

    @Test fun refusedOnceCanStillBeAsked() {
        assertEquals("denied", Rules.state(granted = false, asked = true, rationale = true))
    }

    @Test fun refusedAndNoDialogLeftIsBlocked() {
        assertEquals("blocked", Rules.state(granted = false, asked = true, rationale = false))
    }

    @Test fun closingTheDialogIsNotARefusal() {
        // No rationale after the first dialog: the user closed it. Nothing is remembered, so it isn't "blocked".
        val asked = Rules.askedAfter(asked = false, rationale = false)
        assertFalse(asked)
        assertEquals("denied", Rules.state(granted = false, asked = asked, rationale = false))
    }

    @Test fun aRealRefusalIsRemembered() {
        assertTrue(Rules.askedAfter(asked = false, rationale = true))
        assertTrue(Rules.askedAfter(asked = true, rationale = false))
    }

    @Test fun names() {
        assertEquals(listOf("android.permission.CAMERA"), Rules.androidNames("camera"))
        assertEquals(listOf("android.permission.READ_SMS"), Rules.androidNames("android.permission.READ_SMS"))
        assertNull(Rules.androidNames("cammera"))
    }

    @Test fun locationAsksPreciseAndApproximate() {
        // Android 12+ ignores a request for the precise one alone. Precise first: the answer reads it as location.precise.
        assertEquals(
            listOf("android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"),
            Rules.androidNames("location"),
        )
    }

    @Test fun locationNeedsApproximateInTheManifest() {
        val fine = "android.permission.ACCESS_FINE_LOCATION"
        val coarse = "android.permission.ACCESS_COARSE_LOCATION"
        assertTrue(Rules.missingCoarse("location", setOf(fine))) // the trap: no dialog on Android 12+
        assertFalse(Rules.missingCoarse("location", setOf(fine, coarse)))
        assertFalse(Rules.missingCoarse("location", setOf(coarse))) // approximate only, on purpose
        assertFalse(Rules.missingCoarse("camera", emptySet()))
    }

    @Test fun eitherLocationGrantIsGranted() {
        assertEquals("granted", Rules.combined(listOf("denied", "granted"))) // the user picked "approximate"
        assertEquals("granted", Rules.combined(listOf("granted", "granted")))
        assertEquals("blocked", Rules.combined(listOf("blocked", "blocked")))
        assertEquals("denied", Rules.combined(listOf("denied", "denied")))
    }
}

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
        assertEquals("android.permission.CAMERA", Rules.androidName("camera"))
        assertEquals("android.permission.READ_SMS", Rules.androidName("android.permission.READ_SMS"))
        assertNull(Rules.androidName("cammera"))
    }
}

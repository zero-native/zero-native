package dev.zeronative.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** TextField autoComplete (registry 17, R36): every RN name has an Android autofill hint; "off" has none. */
class ZnAutofillTest {
    @Test
    fun everyValueHasAHint() {
        assertNull(autofillHint(Registry.AutoComplete.OFF))
        for (v in Registry.AutoComplete.TEL..Registry.AutoComplete.GENDER) assertNotNull("value $v", autofillHint(v))
        // An enum value from a newer bundle than this app knows: no hint, no crash.
        assertNull(autofillHint(Registry.AutoComplete.GENDER + 1))
    }

    @Test
    fun loginFieldsGetTheirHints() {
        assertEquals(androidx.compose.ui.autofill.ContentType.PhoneNumberNational, autofillHint(Registry.AutoComplete.TEL_NATIONAL))
        assertEquals(androidx.compose.ui.autofill.ContentType.SmsOtpCode, autofillHint(Registry.AutoComplete.SMS_OTP))
    }
}

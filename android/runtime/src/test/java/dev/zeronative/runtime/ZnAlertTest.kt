package dev.zeronative.runtime

import android.content.DialogInterface
import org.junit.Assert.assertEquals
import org.junit.Test

/** Where Alert buttons go (ZnAlert.places): React Native's places on Android. */
class ZnAlertTest {
    @Test fun oneButtonIsPositive() {
        assertEquals(listOf(DialogInterface.BUTTON_POSITIVE), ZnAlert.places(1))
    }

    @Test fun twoButtonsAreNegativeThenPositive() {
        assertEquals(listOf(DialogInterface.BUTTON_NEGATIVE, DialogInterface.BUTTON_POSITIVE), ZnAlert.places(2))
    }

    @Test fun threeButtonsAreNeutralNegativePositive() {
        assertEquals(
            listOf(DialogInterface.BUTTON_NEUTRAL, DialogInterface.BUTTON_NEGATIVE, DialogInterface.BUTTON_POSITIVE),
            ZnAlert.places(3),
        )
    }

    @Test(expected = IllegalArgumentException::class) fun fourButtonsDoNotFit() {
        ZnAlert.places(4)
    }

    @Test(expected = IllegalArgumentException::class) fun noButtonsIsNotAnAlert() {
        ZnAlert.places(0)
    }
}

package dev.zeronative.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What JS can open (ZnOs.allowsUrl), and how a `zn://` handle reads (ZnHandles.parse). */
class ZnOsTest {
    @Test fun webMailAndPhoneLinksOpen() {
        for (url in listOf("https://x.in/a?b=1", "http://x.in", "HTTPS://X.IN", "mailto:a@b.in", "tel:+919999999999")) {
            assertTrue(url, ZnOs.allowsUrl(url))
        }
    }

    @Test fun otherAppsLinksOpenAsInRn() {
        val opened = listOf("whatsapp://send?text=hi", "upi://pay?pa=x@y", "sms:+919999999999", "geo:12.9,77.6", "market://details?id=x", "content://x", "zn://sample/pay")
        for (url in opened) assertTrue(url, ZnOs.allowsUrl(url))
    }

    @Test fun blockedAndSchemelessLinksDoNot() {
        val refused = listOf("intent://x#Intent;end", "INTENT:#Intent;end", "file:///data/x", "javascript:x", "https", "", "//x.in", "1abc:x", ":x")
        for (url in refused) assertFalse(url, ZnOs.allowsUrl(url))
    }

    @Test fun aHandleHasAKindAndAPath() {
        assertEquals("app-icon" to "com.phonepe.app", ZnHandles.parse("zn://app-icon/com.phonepe.app"))
        assertEquals("file" to "kyc/front.jpg", ZnHandles.parse("zn://file/kyc/front.jpg"))
    }

    @Test fun otherTextIsNotAHandle() {
        for (uri in listOf("https://x.in/a.png", "zn://app-icon", "zn://app-icon/", "zn:///x", "zn://")) assertNull(uri, ZnHandles.parse(uri))
    }
}

package dev.zeronative.runtime

import android.net.NetworkCapabilities.TRANSPORT_BLUETOOTH
import android.net.NetworkCapabilities.TRANSPORT_CELLULAR
import android.net.NetworkCapabilities.TRANSPORT_ETHERNET
import android.net.NetworkCapabilities.TRANSPORT_VPN
import android.net.NetworkCapabilities.TRANSPORT_WIFI
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** What JS gets for a network (ZnNetInfo.typeOf, stateJson). */
class ZnNetInfoTest {
    /** Same keys and values, in any order (the JVM tests use the real org.json, which keeps no key order). */
    private fun assertState(expected: String, actual: JSONObject) = assertEquals(fields(JSONObject(expected)), fields(actual))

    private fun fields(o: JSONObject): Map<String, Any?> =
        o.keys().asSequence().associateWith { key -> o.get(key).let { if (it is JSONObject) fields(it) else it } }

    @Test fun eachTransportHasItsType() {
        assertEquals("wifi", ZnNetInfo.typeOf(setOf(TRANSPORT_WIFI)))
        assertEquals("cellular", ZnNetInfo.typeOf(setOf(TRANSPORT_CELLULAR)))
        assertEquals("ethernet", ZnNetInfo.typeOf(setOf(TRANSPORT_ETHERNET)))
        assertEquals("bluetooth", ZnNetInfo.typeOf(setOf(TRANSPORT_BLUETOOTH)))
        assertEquals("vpn", ZnNetInfo.typeOf(setOf(TRANSPORT_VPN)))
        assertEquals("other", ZnNetInfo.typeOf(emptySet()))
    }

    @Test fun aVpnReadsAsTheNetworkItRunsOn() {
        assertEquals("wifi", ZnNetInfo.typeOf(setOf(TRANSPORT_VPN, TRANSPORT_WIFI)))
        assertEquals("cellular", ZnNetInfo.typeOf(setOf(TRANSPORT_CELLULAR, TRANSPORT_VPN)))
    }

    @Test fun noNetwork() {
        assertState(
            """{"type":"none","isConnected":false,"isInternetReachable":false,"details":null}""",
            ZnNetInfo.stateJson(null),
        )
    }

    @Test fun wifiCheckedByAndroid() {
        val r = ZnNetInfo.Reading(setOf(TRANSPORT_WIFI), internet = true, validated = true, notMetered = true)
        assertState(
            """{"type":"wifi","isConnected":true,"isInternetReachable":true,"details":{"isConnectionExpensive":false}}""",
            ZnNetInfo.stateJson(r),
        )
    }

    @Test fun mobileDataNotCheckedYet() {
        val r = ZnNetInfo.Reading(setOf(TRANSPORT_CELLULAR), internet = true, validated = false, notMetered = false)
        assertState(
            """{"type":"cellular","isConnected":true,"isInternetReachable":false,"details":{"isConnectionExpensive":true}}""",
            ZnNetInfo.stateJson(r),
        )
    }

    @Test fun aBlockedAppHasNoNetwork() {
        // Android blocks this app on a working network (onBlockedStatusChanged): JS reads "none", as NetInfo.fetch does.
        val r = ZnNetInfo.Reading(setOf(TRANSPORT_CELLULAR), internet = true, validated = true, notMetered = false)
        assertState(
            """{"type":"none","isConnected":false,"isInternetReachable":false,"details":null}""",
            ZnNetInfo.stateJson(r, blocked = true),
        )
    }

    @Test fun aNetworkWithoutInternetIsNotConnected() {
        // A Wi-Fi with no internet (a printer's own Wi-Fi, say): validated means nothing without INTERNET.
        val r = ZnNetInfo.Reading(setOf(TRANSPORT_WIFI), internet = false, validated = true, notMetered = true)
        val json = ZnNetInfo.stateJson(r)
        assertEquals(false, json.get("isConnected"))
        assertEquals(false, json.get("isInternetReachable"))
    }

    @Test fun unknown() {
        assertState(
            """{"type":"unknown","isConnected":null,"isInternetReachable":null,"details":null}""",
            ZnNetInfo.unknownJson(),
        )
    }
}

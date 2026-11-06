package dev.zeronative.plugins.deviceinfo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceInfoRulesTest {
    private fun fields(
        fingerprint: String = "Lava/BLAZE2_5G/LXX505:14/UP1A/1:user/release-keys",
        model: String = "LXX505",
        manufacturer: String = "LAVA",
        hardware: String = "mt6833",
        product: String = "LXX505",
        board: String = "LXX505",
        bootloader: String = "unknown",
        brand: String = "LAVA",
        device: String = "LXX505",
    ) = DeviceInfoRules.BuildFields(fingerprint, model, manufacturer, hardware, product, board, bootloader, brand, device)

    @Test
    fun aRealPhoneIsNotAnEmulator() {
        assertFalse(DeviceInfoRules.isEmulator(fields()))
    }

    @Test
    fun theUsualEmulatorsAreFound() {
        // The Android Studio emulator (Google Play image).
        assertTrue(DeviceInfoRules.isEmulator(fields(hardware = "ranchu", product = "sdk_gphone64_x86_64")))
        assertTrue(DeviceInfoRules.isEmulator(fields(fingerprint = "generic/sdk/generic:8.0.0/OSR1/1:userdebug/test-keys")))
        assertTrue(DeviceInfoRules.isEmulator(fields(manufacturer = "Genymotion")))
        assertTrue(DeviceInfoRules.isEmulator(fields(board = "NOX")))
        assertTrue(DeviceInfoRules.isEmulator(fields(brand = "generic_x86", device = "generic_x86")))
        assertFalse(DeviceInfoRules.isEmulator(fields(brand = "generic"))) // both brand and device must say generic
    }

    @Test
    fun deviceTypeUsesTheSmallestWidth() {
        assertEquals("Handset", DeviceInfoRules.deviceType(isTv = false, smallestWidthDp = 411))
        assertEquals("Tablet", DeviceInfoRules.deviceType(isTv = false, smallestWidthDp = 600))
        assertEquals("Tv", DeviceInfoRules.deviceType(isTv = true, smallestWidthDp = 900))
    }

    @Test
    fun battery() {
        assertEquals(0.42, DeviceInfoRules.batteryLevel(42, 100), 1e-9)
        assertEquals(-1.0, DeviceInfoRules.batteryLevel(-1, 100), 0.0)
        assertEquals(-1.0, DeviceInfoRules.batteryLevel(50, 0), 0.0)
        assertEquals("charging", DeviceInfoRules.batteryState(2))
        assertEquals("full", DeviceInfoRules.batteryState(5))
        assertEquals("unplugged", DeviceInfoRules.batteryState(3))
        assertEquals("unplugged", DeviceInfoRules.batteryState(4))
        assertEquals("unknown", DeviceInfoRules.batteryState(1))
    }

    @Test
    fun readableVersion() {
        assertEquals("4.2.0.168", DeviceInfoRules.readableVersion("4.2.0", "168"))
    }
}

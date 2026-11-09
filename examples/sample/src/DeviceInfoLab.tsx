// A dev screen for @zero-native/device-info (react-native-device-info's API). The first line is read at module level,
// before any screen: that is what the sync constants are for (`const BASE_URL = ...`). Each action logs one
// "device-info-lab ..." line.
import { Column, Pressable, Scroll, Text } from "@zero-native/ui"
import { signal } from "@zero-native/core"
import DeviceInfo from "@zero-native/device-info"
import { AdId } from "@zero-native/android-ad-id"
import { c } from "./tokens"

const AT_MODULE_LOAD = `${DeviceInfo.getBundleId()} ${DeviceInfo.getVersion()} (${DeviceInfo.getBuildNumber()})`

const fixed = () =>
  [
    `module level: ${AT_MODULE_LOAD}`,
    `uniqueId: ${DeviceInfo.getUniqueIdSync()}`,
    `app: ${DeviceInfo.getApplicationName()}, ${DeviceInfo.getReadableVersion()}`,
    `phone: ${DeviceInfo.getBrand()} ${DeviceInfo.getModel()} (${DeviceInfo.getDeviceId()}), ${DeviceInfo.getManufacturerSync()}`,
    `${DeviceInfo.getSystemName()} ${DeviceInfo.getSystemVersion()}, API ${DeviceInfo.getApiLevelSync()}, patch ${DeviceInfo.getSecurityPatchSync()}`,
    `type: ${DeviceInfo.getDeviceType()}, tablet ${DeviceInfo.isTablet()}, notch ${DeviceInfo.hasNotch()}, island ${DeviceInfo.hasDynamicIsland()}, emulator ${DeviceInfo.isEmulatorSync()}`,
    `name: ${DeviceInfo.getDeviceNameSync()}`,
    `installer: ${DeviceInfo.getInstallerPackageNameSync()}`,
    `installed ${new Date(DeviceInfo.getFirstInstallTimeSync()).toISOString()}, updated ${new Date(DeviceInfo.getLastUpdateTimeSync()).toISOString()}`,
    `memory: ${Math.round(DeviceInfo.getTotalMemorySync() / 1e6)} MB, low-RAM ${DeviceInfo.isLowRamDevice()}`,
    `abis: ${DeviceInfo.supportedAbisSync().join(", ")}`,
  ].join("\n")

export function DeviceInfoLabScreen() {
  const changing = signal("not read yet")
  const adId = signal("ad id not read yet")

  const read = async () => {
    const [battery, power, disk, total, airplane, location, headphones, secure, font, carrier, ip, gms, ua] = await Promise.all([
      DeviceInfo.getBatteryLevel(),
      DeviceInfo.getPowerState(),
      DeviceInfo.getFreeDiskStorage(),
      DeviceInfo.getTotalDiskCapacity(),
      DeviceInfo.isAirplaneMode(),
      DeviceInfo.isLocationEnabled(),
      DeviceInfo.isHeadphonesConnected(),
      DeviceInfo.isPinOrFingerprintSet(),
      DeviceInfo.getFontScale(),
      DeviceInfo.getCarrier(),
      DeviceInfo.getIpAddress(),
      DeviceInfo.hasGms(),
      DeviceInfo.getUserAgent(),
    ])
    const text = [
      `battery: ${battery}, ${power.batteryState}, saver ${power.lowPowerMode}`,
      `disk: ${Math.round(disk / 1e9)} of ${Math.round(total / 1e9)} GB free`,
      `airplane ${airplane}, location ${location}, headphones ${headphones}, lock set ${secure}`,
      `font scale ${font}, carrier ${carrier}, ip ${ip}, GMS ${gms}`,
      `user agent: ${ua}`,
    ].join("\n")
    console.info(`device-info-lab ${text.replace(/\n/g, " | ")}`)
    changing.set(text)
  }

  return (
    <Scroll style={{ flex: 1, padding: 16, gap: 16 }}>
      <Text fontSize={15} fontWeight={700} color={c.ink}>
        Fixed (sync)
      </Text>
      <Text testID="device-info-fixed" fontSize={13} color={c.ink}>
        {fixed()}
      </Text>
      <Column style={{ gap: 8 }}>
        <Pressable
          onPress={() => void read()}
          alignItems="center"
          style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}
        >
          <Text fontSize={13} fontWeight={600} color={c.white}>
            Read changing values
          </Text>
        </Pressable>
        <Text testID="device-info-changing" fontSize={13} color={c.muted}>
          {changing()}
        </Text>
        {/* @zero-native/android-ad-id (2026-11-07): logs "device-info-lab ad id ..." */}
        <Pressable
          onPress={() =>
            void AdId.get().then((a) => {
              const text = `ad id ${a.id ?? "none"}, limit ad tracking ${a.limitAdTracking}`
              console.info(`device-info-lab ${text}`)
              adId.set(text)
            })
          }
          alignItems="center"
          style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}
        >
          <Text fontSize={13} fontWeight={600} color={c.white}>
            Read advertising id
          </Text>
        </Pressable>
        <Text testID="device-info-ad-id" fontSize={13} color={c.muted}>
          {adId()}
        </Text>
      </Column>
    </Scroll>
  )
}

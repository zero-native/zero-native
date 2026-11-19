// react-native-device-info for zero-native: the same names, the same values. Native side: android/.../DeviceInfoPlugin.kt
// and ios/DeviceInfoPlugin.swift (react-native-device-info's iOS answers). README: which calls differ.
//
//   import DeviceInfo from "@zeronative/device-info"
//   const BASE_URL = DeviceInfo.getBundleId() === "com.example.app" ? PROD : DEV   // sync, also at module level
//   const id = DeviceInfo.getUniqueIdSync()
//   const level = await DeviceInfo.getBatteryLevel()
//
// Values that can't change while the app runs come from native before the app's JS starts (`nativeConstants`), so the
// plain and `Sync` getters answer at once. Values that change (battery, disk, network) are calls and answer a Promise.
// Nothing rejects: a value the phone doesn't give answers what react-native-device-info answers then ("unknown", -1,
// false, []).
import { nativeConstants, nativeModule, type CallOptions } from "@zeronative/core"

export type DeviceType = "Handset" | "Tablet" | "Tv" | "Desktop" | "GamingConsole" | "Headset" | "unknown"
export type BatteryState = "unknown" | "unplugged" | "charging" | "full"

export interface PowerState {
  batteryLevel: number
  batteryState: BatteryState
  lowPowerMode: boolean
}

/** What native gives before the app's JS starts (DeviceInfoModule.readConstants). */
export interface DeviceInfoConstants {
  bundleId: string
  applicationName: string
  version: string
  buildNumber: string
  readableVersion: string
  firstInstallTime: number
  lastUpdateTime: number
  installerPackageName: string
  uniqueId: string
  androidId: string
  deviceId: string
  model: string
  brand: string
  manufacturer: string
  systemName: string
  systemVersion: string
  apiLevel: number
  baseOs: string
  bootloader: string
  buildId: string
  codename: string
  device: string
  display: string
  fingerprint: string
  hardware: string
  host: string
  incremental: string
  product: string
  tags: string
  type: string
  previewSdkInt: number
  securityPatch: string
  deviceType: DeviceType
  isTablet: boolean
  hasNotch: boolean
  isEmulator: boolean
  supportedAbis: string[]
  supported32BitAbis: string[]
  supported64BitAbis: string[]
  maxMemory: number
  totalMemory: number
  isLowRamDevice: boolean
  deviceName: string
  /** iOS only (absent on Android: false). */
  hasDynamicIsland?: boolean
  isDisplayZoomed?: boolean
}

interface DeviceInfoModule {
  batteryLevel(args?: Record<string, never>, options?: CallOptions): Promise<number | null>
  powerState(args?: Record<string, never>, options?: CallOptions): Promise<PowerState | null>
  isBatteryCharging(args?: Record<string, never>, options?: CallOptions): Promise<boolean | null>
  freeDiskStorage(args?: Record<string, never>, options?: CallOptions): Promise<number | null>
  totalDiskCapacity(args?: Record<string, never>, options?: CallOptions): Promise<number | null>
  usedMemory(args?: Record<string, never>, options?: CallOptions): Promise<number | null>
  isAirplaneMode(args?: Record<string, never>, options?: CallOptions): Promise<boolean | null>
  isLocationEnabled(args?: Record<string, never>, options?: CallOptions): Promise<boolean | null>
  isHeadphonesConnected(args?: Record<string, never>, options?: CallOptions): Promise<boolean | null>
  isPinOrFingerprintSet(args?: Record<string, never>, options?: CallOptions): Promise<boolean | null>
  fontScale(args?: Record<string, never>, options?: CallOptions): Promise<number | null>
  isLandscape(args?: Record<string, never>, options?: CallOptions): Promise<boolean | null>
  carrier(args?: Record<string, never>, options?: CallOptions): Promise<string | null>
  ipAddress(args?: Record<string, never>, options?: CallOptions): Promise<string | null>
  isCameraPresent(args?: Record<string, never>, options?: CallOptions): Promise<boolean | null>
  systemAvailableFeatures(args?: Record<string, never>, options?: CallOptions): Promise<string[] | null>
  hasGms(args?: Record<string, never>, options?: CallOptions): Promise<boolean | null>
  hasHms(args?: Record<string, never>, options?: CallOptions): Promise<boolean | null>
  userAgent(args?: Record<string, never>, options?: CallOptions): Promise<string | null>
  hasSystemFeature(args: { feature: string }, options?: CallOptions): Promise<boolean>
  /** iOS only: Android has no such call, so it answers -1 there. */
  brightness(args?: Record<string, never>, options?: CallOptions): Promise<number | null>
}

const Native = nativeModule<DeviceInfoModule>("DeviceInfo", { version: 1 })
const unowned: CallOptions = { owned: false } // module-level code and stores call these too

let read: Partial<DeviceInfoConstants> | null = null
const all = (): Partial<DeviceInfoConstants> => (read ??= nativeConstants<DeviceInfoConstants>("DeviceInfo") ?? {})

/** Tests only: read the constants again. */
export function resetDeviceInfoForTests(): void {
  read = null
}

const str = (key: keyof DeviceInfoConstants) => (): string => {
  const v = all()[key]
  return typeof v === "string" ? v : "unknown"
}
const num = (key: keyof DeviceInfoConstants) => (): number => {
  const v = all()[key]
  return typeof v === "number" ? v : -1
}
const bool = (key: keyof DeviceInfoConstants) => (): boolean => all()[key] === true
const list = (key: keyof DeviceInfoConstants) => (): string[] => {
  const v = all()[key]
  return Array.isArray(v) ? [...(v as string[])] : []
}
const later = <T>(sync: () => T) => (): Promise<T> => Promise.resolve(sync())

/** A changing value: the call's answer, or [fallback] when native gives none or the call fails. */
const ask = <T>(call: () => Promise<T | null>, fallback: T) => (): Promise<T> =>
  call().then(
    (v) => (v === null || v === undefined ? fallback : v),
    () => fallback,
  )

// Fixed values: plain getters (sync in react-native-device-info too).
export const getApplicationName = str("applicationName")
export const getBrand = str("brand")
export const getBuildNumber = str("buildNumber")
export const getBundleId = str("bundleId")
export const getDeviceId = str("deviceId")
export const getDeviceType = (): DeviceType => str("deviceType")() as DeviceType
export const getModel = str("model")
export const getReadableVersion = str("readableVersion")
export const getSystemName = (): string => all().systemName ?? "Android"
export const getSystemVersion = str("systemVersion")
export const getVersion = str("version")
export const isTablet = bool("isTablet")
export const hasNotch = bool("hasNotch")
export const isLowRamDevice = bool("isLowRamDevice")
/** iOS only: false on Android. */
export const hasDynamicIsland = bool("hasDynamicIsland")
/** iOS only: false on Android. */
export const isDisplayZoomed = bool("isDisplayZoomed")

// Fixed values with a Promise form and a Sync form, as in react-native-device-info.
export const getAndroidIdSync = str("androidId")
export const getAndroidId = later(getAndroidIdSync)
export const getApiLevelSync = num("apiLevel")
export const getApiLevel = later(getApiLevelSync)
export const getBaseOsSync = str("baseOs")
export const getBaseOs = later(getBaseOsSync)
export const getBootloaderSync = str("bootloader")
export const getBootloader = later(getBootloaderSync)
export const getBuildIdSync = str("buildId")
export const getBuildId = later(getBuildIdSync)
export const getCodenameSync = str("codename")
export const getCodename = later(getCodenameSync)
export const getDeviceSync = str("device")
export const getDevice = later(getDeviceSync)
export const getDeviceNameSync = str("deviceName")
export const getDeviceName = later(getDeviceNameSync)
export const getDisplaySync = str("display")
export const getDisplay = later(getDisplaySync)
export const getFingerprintSync = str("fingerprint")
export const getFingerprint = later(getFingerprintSync)
export const getFirstInstallTimeSync = num("firstInstallTime")
export const getFirstInstallTime = later(getFirstInstallTimeSync)
export const getHardwareSync = str("hardware")
export const getHardware = later(getHardwareSync)
export const getHostSync = str("host")
export const getHost = later(getHostSync)
export const getIncrementalSync = str("incremental")
export const getIncremental = later(getIncrementalSync)
export const getInstallerPackageNameSync = str("installerPackageName")
export const getInstallerPackageName = later(getInstallerPackageNameSync)
export const getLastUpdateTimeSync = num("lastUpdateTime")
export const getLastUpdateTime = later(getLastUpdateTimeSync)
export const getManufacturerSync = str("manufacturer")
export const getManufacturer = later(getManufacturerSync)
export const getMaxMemorySync = num("maxMemory")
export const getMaxMemory = later(getMaxMemorySync)
export const getPreviewSdkIntSync = num("previewSdkInt")
export const getPreviewSdkInt = later(getPreviewSdkIntSync)
export const getProductSync = str("product")
export const getProduct = later(getProductSync)
export const getSecurityPatchSync = str("securityPatch")
export const getSecurityPatch = later(getSecurityPatchSync)
export const getTagsSync = str("tags")
export const getTags = later(getTagsSync)
export const getTypeSync = str("type")
export const getType = later(getTypeSync)
export const getTotalMemorySync = num("totalMemory")
export const getTotalMemory = later(getTotalMemorySync)
/** Android's ANDROID_ID, as react-native-device-info gives on Android: one per app signing key, user and phone. */
export const getUniqueIdSync = str("uniqueId")
export const getUniqueId = later(getUniqueIdSync)
/** iOS keeps the id in the Keychain; on Android it is the same as getUniqueId. */
export const syncUniqueId = getUniqueId
export const isEmulatorSync = bool("isEmulator")
export const isEmulator = later(isEmulatorSync)
export const supportedAbisSync = list("supportedAbis")
export const supportedAbis = later(supportedAbisSync)
export const supported32BitAbisSync = list("supported32BitAbis")
export const supported32BitAbis = later(supported32BitAbisSync)
export const supported64BitAbisSync = list("supported64BitAbis")
export const supported64BitAbis = later(supported64BitAbisSync)

// Values Android keeps from apps today, or that need a library or a permission this plugin doesn't add: the same
// answers react-native-device-info gives then (README).
export const getMacAddressSync = (): string => "02:00:00:00:00:00"
export const getMacAddress = later(getMacAddressSync)
export const getSerialNumberSync = (): string => "unknown"
export const getSerialNumber = later(getSerialNumberSync)
export const getPhoneNumberSync = (): string => "unknown"
export const getPhoneNumber = later(getPhoneNumberSync)
export const getInstallReferrerSync = (): string => "unknown"
export const getInstallReferrer = later(getInstallReferrerSync)
/** Windows only: false on Android. */
export const isKeyboardConnected = (): Promise<boolean> => Promise.resolve(false)
export const isMouseConnected = (): Promise<boolean> => Promise.resolve(false)
export const isTabletMode = (): Promise<boolean> => Promise.resolve(false)

// Values that change while the app runs: a Promise only (no Sync form; README).
export const getBatteryLevel = ask(() => Native.batteryLevel({}, unowned), -1)
export const getPowerState = ask<Partial<PowerState>>(() => Native.powerState({}, unowned), {})
export const isBatteryCharging = ask(() => Native.isBatteryCharging({}, unowned), false)
export const getFreeDiskStorage = ask(() => Native.freeDiskStorage({}, unowned), -1)
export const getFreeDiskStorageOld = getFreeDiskStorage
export const getTotalDiskCapacity = ask(() => Native.totalDiskCapacity({}, unowned), -1)
export const getTotalDiskCapacityOld = getTotalDiskCapacity
export const getUsedMemory = ask(() => Native.usedMemory({}, unowned), -1)
export const isAirplaneMode = ask(() => Native.isAirplaneMode({}, unowned), false)
export const isLocationEnabled = ask(() => Native.isLocationEnabled({}, unowned), false)
export const isHeadphonesConnected = ask(() => Native.isHeadphonesConnected({}, unowned), false)
export const isPinOrFingerprintSet = ask(() => Native.isPinOrFingerprintSet({}, unowned), false)
export const getFontScale = ask(() => Native.fontScale({}, unowned), -1)
export const isLandscape = ask(() => Native.isLandscape({}, unowned), false)
export const getCarrier = ask(() => Native.carrier({}, unowned), "unknown")
export const getIpAddress = ask(() => Native.ipAddress({}, unowned), "unknown")
export const isCameraPresent = ask(() => Native.isCameraPresent({}, unowned), false)
export const getSystemAvailableFeatures = ask<string[]>(() => Native.systemAvailableFeatures({}, unowned), [])
export const hasGms = ask(() => Native.hasGms({}, unowned), false)
export const hasHms = ask(() => Native.hasHms({}, unowned), false)
export const getUserAgent = ask(() => Native.userAgent({}, unowned), "unknown")
/** iOS only (the screen's brightness, 0 to 1): -1 on Android, which has no such call. */
export const getBrightness = ask(() => Native.brightness({}, unowned), -1)
export const hasSystemFeature = (feature: string): Promise<boolean> =>
  Native.hasSystemFeature({ feature }, unowned).then(
    (v) => v === true,
    () => false,
  )

/** `import DeviceInfo from "react-native-device-info"`: every getter above on one object. */
const DeviceInfo = {
  getApplicationName, getBrand, getBuildNumber, getBundleId, getDeviceId, getDeviceType, getModel, getReadableVersion,
  getSystemName, getSystemVersion, getVersion, isTablet, hasNotch, isLowRamDevice, hasDynamicIsland, isDisplayZoomed,
  getAndroidId, getAndroidIdSync, getApiLevel, getApiLevelSync, getBaseOs, getBaseOsSync, getBootloader, getBootloaderSync,
  getBuildId, getBuildIdSync, getCodename, getCodenameSync, getDevice, getDeviceSync, getDeviceName, getDeviceNameSync,
  getDisplay, getDisplaySync, getFingerprint, getFingerprintSync, getFirstInstallTime, getFirstInstallTimeSync,
  getHardware, getHardwareSync, getHost, getHostSync, getIncremental, getIncrementalSync, getInstallerPackageName,
  getInstallerPackageNameSync, getLastUpdateTime, getLastUpdateTimeSync, getManufacturer, getManufacturerSync,
  getMaxMemory, getMaxMemorySync, getPreviewSdkInt, getPreviewSdkIntSync, getProduct, getProductSync, getSecurityPatch,
  getSecurityPatchSync, getTags, getTagsSync, getType, getTypeSync, getTotalMemory, getTotalMemorySync, getUniqueId,
  getUniqueIdSync, syncUniqueId, isEmulator, isEmulatorSync, supportedAbis, supportedAbisSync, supported32BitAbis,
  supported32BitAbisSync, supported64BitAbis, supported64BitAbisSync, getMacAddress, getMacAddressSync, getSerialNumber,
  getSerialNumberSync, getPhoneNumber, getPhoneNumberSync, getInstallReferrer, getInstallReferrerSync, getBrightness,
  isKeyboardConnected, isMouseConnected, isTabletMode, getBatteryLevel, getPowerState, isBatteryCharging,
  getFreeDiskStorage, getFreeDiskStorageOld, getTotalDiskCapacity, getTotalDiskCapacityOld, getUsedMemory,
  isAirplaneMode, isLocationEnabled, isHeadphonesConnected, isPinOrFingerprintSet, getFontScale, isLandscape, getCarrier,
  getIpAddress, isCameraPresent, getSystemAvailableFeatures, hasGms, hasHms, getUserAgent, hasSystemFeature,
}

export default DeviceInfo

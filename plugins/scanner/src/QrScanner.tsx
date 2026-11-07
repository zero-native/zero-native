// The camera inside a screen. It fills its parent, so put it in a Box with a size: a style can't come through a prop, as
// layout is fixed at build time.
import { NativeView } from "@zero-native/ui"
import { handleScannerEvent, type QrScannerProps } from "./module"

export function QrScanner(props: QrScannerProps) {
  return (
    <NativeView
      name="scanner.qr"
      props={{
        torch: props.torch ?? false,
        active: props.active ?? true,
        scanKey: String(props.scanKey ?? ""),
        askPermission: props.askPermission ?? true,
        formats: props.formats ?? [],
        zoom: props.zoom ?? null,
        autoZoom: props.autoZoom ?? false,
        pinchZoom: props.pinchZoom ?? true,
        permissionTitle: props.permissionTitle ?? null,
        permissionBody: props.permissionBody ?? null,
        blockedBody: props.blockedBody ?? null,
        allowLabel: props.allowLabel ?? null,
        settingsLabel: props.settingsLabel ?? null,
        failedTitle: props.failedTitle ?? null,
        failedBody: props.failedBody ?? null,
        retryLabel: props.retryLabel ?? null,
        buttonColor: props.buttonColor ?? null,
        buttonTextColor: props.buttonTextColor ?? null,
      }}
      onEvent={(e) => handleScannerEvent(props, e)}
      style={{ width: "100%", height: "100%" }}
    />
  )
}

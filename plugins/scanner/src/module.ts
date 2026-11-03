// The scanner plugin's JS side, without the component. Native side: android/.../ScannerModule.kt. No side effects:
// nativeModule() only creates a handle.
import { nativeModule } from "@zero-native/core"

export interface ScannerModule {
  /** True if the phone has a camera. */
  available(): Promise<boolean>
}

export const Scanner = nativeModule<ScannerModule>("Scanner", { version: 1 })

/** What the screen answers, and what the view's `onScan` gets. */
export interface ScanResult {
  value: string
  /** "qr", "ean13", "code128" and so on. */
  format: BarcodeFormat
}

export type BarcodeFormat = "qr" | "aztec" | "datamatrix" | "pdf417" | "ean13" | "ean8" | "upca" | "upce" | "code128" | "code39" | "code93" | "codabar" | "itf"

/** "blocked": Android won't ask again; the scanner shows a button to the settings page. */
export type ScanPermission = "granted" | "denied" | "blocked"

/** Words and colours. All optional: the defaults are plain and belong to no brand. */
export interface ScannerLook {
  permissionTitle?: string
  permissionBody?: string
  /** The message when Android won't ask again. */
  blockedBody?: string
  allowLabel?: string
  settingsLabel?: string
  failedTitle?: string
  failedBody?: string
  retryLabel?: string
  /** Buttons on the messages, as "#RRGGBB". */
  buttonColor?: string
  buttonTextColor?: string
}

/** Params of the full screen: `nav.pushForResult<ScanResult>("scan", params)`. */
export interface ScannerParams extends ScannerLook {
  title?: string
  /** A line at the bottom. */
  hint?: string
  /** A button at the bottom that opens a web page. Only http and https links work. */
  linkLabel?: string
  linkUrl?: string
  /** What to look for. Default: QR codes only. */
  formats?: BarcodeFormat[]
  /** The frame and the moving line, as "#RRGGBB". */
  accentColor?: string
  closeLabel?: string
  torchOnLabel?: string
  torchOffLabel?: string
}

export interface QrScannerProps extends ScannerLook {
  /** The first code. The camera then stops until `scanKey` changes. */
  onScan: (result: ScanResult) => void
  /** On at the start, and at each change. */
  onPermission?: (state: ScanPermission) => void
  /** The camera can't start. A message and a "Try again" button are on the view already. */
  onError?: (error: { code: string; message: string }) => void
  /** The torch went off by itself, because the screen left: set your `torch` value to false. */
  onTorchOff?: () => void
  /** Leaving the screen turns it off. It stays off until you set this to false and then to true. */
  torch?: boolean
  /** A new value (any text or number) scans again. Use it for "Scan again". */
  scanKey?: string | number
  /** False stops the camera. Default true. */
  active?: boolean
  /** False: no dialog by itself; the view shows an "Allow camera" button. Default true. */
  askPermission?: boolean
  formats?: BarcodeFormat[]
}

/** An event of `<NativeView name="scanner.qr">`, sent to the right prop of `QrScanner`. */
export function handleScannerEvent(props: QrScannerProps, event: { name: string; data: any }): void {
  switch (event.name) {
    case "scanned":
      return props.onScan(event.data as ScanResult)
    case "permission":
      return props.onPermission?.(event.data.state as ScanPermission)
    case "error":
      return props.onError?.(event.data as { code: string; message: string })
    case "torch":
      return props.onTorchOff?.()
  }
}

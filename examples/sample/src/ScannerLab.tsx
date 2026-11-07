// A dev screen for the scanner plugin. The phone test (tools/plugin-phone/scanner.ts) reads these lines and the log lines "scanner-lab ...".
import { Box, Column, Pressable, Scroll, Text } from "@zero-native/ui"
import { nav, onNavResult, Permissions, signal } from "@zero-native/core"
import { QrScanner, Scanner, type ScanResult } from "@zero-native/scanner"
import { c } from "./tokens"

function ScannerLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export function ScannerLabScreen() {
  console.info(`scanner-lab open ${typeof Scanner}`) // not at the top of the file: imports run before installRuntime()
  const status = signal("ready")
  const showView = signal(false)
  const torch = signal(false)
  const scanKey = signal(0)
  const say = (text: string) => {
    console.info(`scanner-lab ${text}`)
    status.set(text)
  }
  // The answer after a kill, or from a screen opened with nav.push: no promise is waiting for it.
  onNavResult<ScanResult>("scan", (r, ack) => {
    say(`nav result: ${r.value} ${r.format}`)
    ack()
  })

  const open = (params: Record<string, unknown>) =>
    nav.pushForResult<ScanResult>("scan", params).then((r) => say(r ? `answer: ${r.value} ${r.format}` : "answer: null"))
  const plain = () => open({})
  const dressed = () =>
    open({
      title: "Scan any code at the counter",
      hint: "Point the camera at the code",
      linkLabel: "How it works",
      linkUrl: "https://example.com/",
      accentColor: "#FFD54F",
      buttonColor: "#FFD54F",
      formats: ["qr", "ean13"],
    })
  const setTorch = (on: boolean) => {
    torch.set(on)
    say(`torch prop: ${on}`)
  }
  const scanAgain = () => {
    scanKey.set(scanKey() + 1)
    say("scan again")
  }
  const hasCamera = () => Scanner.available().then((r) => say(`has camera: ${r}`))
  const permission = () => Permissions.status(["camera"]).then((r) => say(`permission: ${r.camera}`))

  return (
    <Scroll style={{ flex: 1, backgroundColor: c.white }}>
      <Column gap={10} style={{ padding: 16 }}>
        <Text fontSize={16}>Scanner lab</Text>
        <Text fontSize={13}>{`status: ${status()}`}</Text>
        <ScannerLabButton label="Open full scanner" onPress={plain} />
        {/* Zoom (as ZeroBill's old app): starts at 1.4x, ML Kit zooms in on a far code, two fingers zoom. */}
        <ScannerLabButton label="Open zoomed scanner" onPress={() => open({ zoom: 1.4, autoZoom: true })} />
        <ScannerLabButton label="Open dressed scanner" onPress={dressed} />
        <ScannerLabButton label="Push full scanner" onPress={() => nav.push("scan", {})} />
        <ScannerLabButton label="Show view" onPress={() => showView.set(true)} />
        <ScannerLabButton label="Hide view" onPress={() => showView.set(false)} />
        <Box style={{ height: 220, backgroundColor: "#DDDDDD" }}>
          {showView() && (
            <QrScanner
              torch={torch()}
              scanKey={scanKey()}
              onScan={(r) => say(`view scanned: ${r.value} ${r.format}`)}
              onPermission={(s) => say(`view permission: ${s}`)}
              onError={(e) => say(`view error: ${e.code}`)}
              onTorchOff={() => {
                torch.set(false)
                say("view torch went off")
              }}
            />
          )}
        </Box>
        <ScannerLabButton label="Torch on" onPress={() => setTorch(true)} />
        <ScannerLabButton label="Torch off" onPress={() => setTorch(false)} />
        <ScannerLabButton label="Scan again" onPress={scanAgain} />
        <ScannerLabButton label="Cover view" onPress={() => nav.push("fakeScreen", { title: "Cover" })} />
        <ScannerLabButton label="Has camera" onPress={hasCamera} />
        <ScannerLabButton label="Read permission" onPress={permission} />
      </Column>
    </Scroll>
  )
}

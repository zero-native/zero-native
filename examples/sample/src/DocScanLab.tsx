// A dev screen for the document scanner plugin. Steps are read from the log lines "docscan-lab ..." (adb logcat -s zn-js).
// The emulator has no working camera: use "Scan both, gallery" and pick a picture (adb push one to /sdcard/Pictures).
// Kill test: open the scanner, then `adb shell am kill dev.zeronative.sample`, then finish the scan. The app starts again and
// the result arrives at onResult below ("restored ..."). "Don't keep activities" (Settings, or `settings put global
// always_finish_activities 1` plus a reboot: adb alone doesn't reach the running system) only rebuilds the screens; put it back after.
// iOS: the gallery buttons ask Camera / Photos (straight to Photos on the simulator, which has no document camera; with
// SIMCTL_CHILD_ZN_DOCSCAN_FAKE=2 the camera is a fake one, so the sheet shows). "Download" logs one "event" line.
import { Box, Column, Image, Pressable, Scroll, Text } from "@zeronative/ui"
import { signal } from "@zeronative/core"
import { DocumentScanner, type ScanDocumentResponse, type ScannerStatus } from "@zeronative/document-scanner"
import { c } from "./tokens"

function DocScanLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

const statusLine = (s: ScannerStatus) =>
  `${s.status}${s.reason ? ` ${s.reason}` : ""}${s.state ? ` ${s.state} ${s.bytes ?? 0}/${s.total ?? 0}` : ""}`

export function DocScanLabScreen() {
  // Not at the top of the file: imports run before installRuntime().
  const open = DocumentScanner.pending()
  console.info(`docscan-lab open pending ${open ? `${open.status} ${open.tag ?? "-"}` : "none"}`)
  const status = signal("ready")
  const module = signal("?")
  const shown = signal("")
  const say = (text: string) => {
    console.info(`docscan-lab ${text}`)
    status.set(text)
  }
  const report = (word: string, r: ScanDocumentResponse) => {
    const pdf = r.pdf ? ` pdf ${r.pdf.pageCount}p ${r.pdf.size}` : ""
    const page = r.pages[0] ? ` first ${r.pages[0].width}x${r.pages[0].height} ${r.pages[0].size}` : ""
    say(`${word} ${r.status}${r.reason ? ` ${r.reason}` : ""} tag ${r.tag ?? "-"} pages ${r.pages.length}${page}${pdf}`)
    shown.set(r.scannedImages[0] ?? "")
  }
  const showStatus = (word: string) => (s: ScannerStatus) => {
    module.set(statusLine(s))
    console.info(`docscan-lab ${word} ${statusLine(s)}`)
  }
  // The answer after a kill: the promise of the scan is gone.
  DocumentScanner.onResult((r, ack) => {
    report("restored", r)
    ack()
  })
  DocumentScanner.onStatus(showStatus("event"))
  DocumentScanner.getStatus().then(showStatus("status"))

  let n = 0
  const scan = (word: string, options: Parameters<typeof DocumentScanner.scanDocument>[0]) => {
    say(`${word}: opening`)
    DocumentScanner.scanDocument(options).then(
      (r) => report(word, r),
      (e: { code?: string }) => say(`${word} rejected ${e.code}`),
    )
  }

  return (
    <Scroll style={{ flex: 1, backgroundColor: c.white }}>
      <Column gap={10} style={{ padding: 16 }}>
        <Text fontSize={16}>Document scanner lab</Text>
        <Text fontSize={13}>{`module: ${module()}`}</Text>
        <Text fontSize={13}>{`status: ${status()}`}</Text>
        <Box style={{ height: 120 }}>{shown() !== "" && <Image src={shown()} style={{ width: 90, height: 120 }} />}</Box>
        <DocScanLabButton label="Check status" onPress={() => DocumentScanner.getStatus().then(showStatus("status"))} />
        <DocScanLabButton label="Download" onPress={() => DocumentScanner.download().then(showStatus("download"))} />
        <DocScanLabButton label="Scan pages" onPress={() => scan("scan", { tag: `jpeg-${++n}` })} />
        <DocScanLabButton label="Scan PDF, 5 pages" onPress={() => scan("pdf", { maxNumDocuments: 5, formats: ["pdf"], tag: `order-${++n}` })} />
        <DocScanLabButton label="Scan both, gallery, base mode" onPress={() => scan("both", { formats: ["jpeg", "pdf"], galleryImport: true, mode: "base", tag: `both-${++n}` })} />
        <DocScanLabButton label="Scan both, gallery, filter mode" onPress={() => scan("filter", { formats: ["jpeg", "pdf"], galleryImport: true, mode: "filter", tag: `filter-${++n}` })} />
        <DocScanLabButton label="Bad option" onPress={() => scan("bad", { maxNumDocuments: 0 })} />
        <DocScanLabButton label="Clean all" onPress={() => DocumentScanner.cleanup({ olderThanMs: 0 }).then((r) => say(`cleanup: ${r.deleted} files ${r.bytes} bytes`))} />
      </Column>
    </Scroll>
  )
}

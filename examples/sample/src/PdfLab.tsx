// A dev screen for the pdf plugin. The phone test (tools/plugin-phone/pdf.ts) reads these lines and the log lines "pdf-lab ...".
import { restorableSignal, signal } from "@zero-native/core"
import { Pdf, PdfPreview, PdfView, type PdfAnswer } from "@zero-native/pdf"
import { Box, Column, Pressable, Row, Scroll, Text } from "@zero-native/ui"
import { c } from "./tokens"

const SERVER = "http://localhost:8793" // tools/plugin-phone/pdf-server.ts, through adb reverse

function PdfLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ flex: 1, paddingHorizontal: 6, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={12} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export function PdfLabScreen() {
  const status = signal("ready")
  // Restorable: after a kill the screen comes back with its file, which is still on disk.
  const handle = restorableSignal<string | null>("handle", null)
  const view = signal("")
  const contain = signal(false)
  const say = (text: string) => {
    console.info(`pdf-lab ${text}`)
    status.set(text)
  }
  console.info("pdf-lab open") // not at the top of the file: imports run before installRuntime()

  const show = (r: PdfAnswer, what: string) => {
    if (r.status === "ok") {
      say(`${what}: ok pages=${r.pages} cached=${r.cached} size=${r.size}`)
      handle.set(r.handle)
    } else {
      say(`${what}: failed ${r.reason}${r.httpStatus ? ` ${r.httpStatus}` : ""}`)
    }
  }
  const get = (path: string, extra: { key?: string; maxBytes?: number } = {}) =>
    void Pdf.download({ url: path.startsWith("http") ? path : `${SERVER}${path}`, headers: { "x-zn-lab": "1" }, ...extra }).then((r) => show(r, path))

  return (
    <Column style={{ flex: 1, backgroundColor: c.white }}>
      <Text fontSize={12} color={c.ink} style={{ padding: 8 }}>
        {`status: ${status()}`}
      </Text>
      <Row gap={8} style={{ paddingHorizontal: 8, height: 120 }}>
        {/* The receipt card: width fit, from the top, cut at the box. */}
        <Box style={{ flex: 1, height: 120, borderRadius: 12, borderWidth: 1, borderColor: c.muted, overflow: "hidden" }}>
          <PdfPreview
            source={handle()}
            fit={contain() ? "contain" : "width"}
            onLoad={(i) => say(`preview load: pages=${i.pages}`)}
            onError={(e) => say(`preview error: ${e.reason}`)}
          />
        </Box>
        <Column gap={6} style={{ width: 110 }}>
          <PdfLabButton label="Fit" onPress={() => contain.set(!contain())} />
          <PdfLabButton label="Zoom 3x" onPress={() => void Pdf.debugZoom({ view: view(), scale: 3 }).then((r) => say(`zoom asked: ${r}`))} />
        </Column>
      </Row>
      <Column style={{ height: 300, margin: 8 }}>
        <PdfView
          source={handle()}
          onLoad={(i) => {
            view.set(i.view)
            say(`view load: pages=${i.pages} size=${i.width}x${i.height}`)
          }}
          onPageChange={(p, t) => say(`page ${p} of ${t}`)}
          onZoom={(s) => say(`zoom ${s.toFixed(2)}`)}
          onError={(e) => say(`view error: ${e.reason}${e.page ? ` page ${e.page}` : ""}`)}
        />
      </Column>
      <Scroll style={{ flex: 1 }}>
        <Column gap={8} style={{ padding: 10 }}>
          <Row gap={8}>
            <PdfLabButton label="One page" onPress={() => get("/one.pdf", { key: "lab-one" })} />
            <PdfLabButton label="50 pages" onPress={() => get("/pages50.pdf")} />
            <PdfLabButton label="Roll" onPress={() => get("/roll.pdf")} />
          </Row>
          <Row gap={8}>
            <PdfLabButton label="Password" onPress={() => get("/password.pdf")} />
            <PdfLabButton label="Broken" onPress={() => get("/broken.pdf")} />
            <PdfLabButton label="Html" onPress={() => get("/html.pdf")} />
          </Row>
          <Row gap={8}>
            <PdfLabButton label="Missing" onPress={() => get("/missing.pdf")} />
            <PdfLabButton label="Redirect" onPress={() => get("/redirect")} />
            <PdfLabButton label="Redirect other" onPress={() => get("/redirect-other")} />
          </Row>
          <Row gap={8}>
            <PdfLabButton label="Too big" onPress={() => get("/pages50.pdf", { key: "small", maxBytes: 2000 })} />
            <PdfLabButton label="Not https" onPress={() => get("http://example.com/a.pdf")} />
            <PdfLabButton label="No server" onPress={() => get("http://localhost:8794/a.pdf")} />
          </Row>
          <Row gap={8}>
            <PdfLabButton label="Slow" onPress={() => get("/slow.pdf")} />
            <PdfLabButton label="Bad handle" onPress={() => handle.set("zn://file/pdf-none.pdf")} />
            <PdfLabButton label="Clear" onPress={() => handle.set(null)} />
          </Row>
          <Row gap={8}>
            <PdfLabButton label="Open handle" onPress={() => void Pdf.open({ handle: handle() ?? "" }).then((r) => show(r, "open"))} />
            <PdfLabButton label="Cleanup all" onPress={() => void Pdf.cleanup({ olderThanMs: 0 }).then((r) => say(`cleanup: ${r.deleted}`))} />
          </Row>
        </Column>
      </Scroll>
    </Column>
  )
}

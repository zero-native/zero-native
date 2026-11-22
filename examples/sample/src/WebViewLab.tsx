// A dev screen for the webview plugin. The phone test (tools/plugin-phone/webview.ts) reads these lines and the log lines "webview-lab ...".
import { nav, Os, signal } from "@zeronative/core"
import { Column, Pressable, Row, Scroll, Text } from "@zeronative/ui"
import { WebView, WebViewNative, webViewController } from "@zeronative/webview"
import { c } from "./tokens"

const SERVER = "http://localhost:8790" // tools/plugin-phone/webview-server.ts, through adb reverse
const BLOCKED = "http://127.0.0.1:8790" // the same server, by a name the app doesn't allow
const BASE = "https://lab.zero-native.test/" // no such site: the inline page only acts as this address
// "*" and "intent" are here on purpose: the plugin must drop them and say so (refused=2).
const HOSTS = ["lab.zero-native.test", SERVER, "http://localhost:8791", "*"]
const LEAVE = ["tel", "mailto", "upi", "intent"]

const INLINE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="margin:0;font:16px sans-serif"><p>Inline page</p><script>
document.title = "bridge " + typeof window.ZeroNative
if (window.ZeroNative) {
  ZeroNative.addEventListener("message", function (e) { ZeroNative.postMessage("echo " + e.data.slice(5)) })
  ZeroNative.postMessage("ready inline")
}
</script></body>`

// Upload and media, with no server (the iOS simulator): a file input, and a tone the page plays on a tap and reports
// ("media playing" / "media paused") through the bridge, so a pause (a screen on top, the share sheet, the
// background) shows the media stop. Its base is an allowed host, so the picker may open.
const UPLOAD = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="margin:0;font:16px sans-serif;padding:8px">
<label style="display:inline-block;padding:10px;background:#ddd">Pick files<input id="f" type="file" multiple accept="image/*" style="display:none"></label>
<button id="p" style="padding:10px;margin-left:8px">Play tone</button><p id="s">-</p><script>
function wav() {
  var rate = 8000, n = rate * 2, b = new ArrayBuffer(44 + n * 2), v = new DataView(b)
  function str(o, t) { for (var i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)) }
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true)
  v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true)
  for (var i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / rate * 2 * Math.PI * 440) * 3000, true)
  return URL.createObjectURL(new Blob([b], { type: "audio/wav" }))
}
var a = new Audio(wav()); a.loop = true
function tell(t) { document.getElementById("s").textContent = t; if (window.ZeroNative) ZeroNative.postMessage(t) }
a.addEventListener("playing", function () { tell("media playing") })
a.addEventListener("pause", function () { tell("media paused") })
document.getElementById("p").onclick = function () { a.play() }
document.getElementById("f").onchange = function (e) { tell("page saw " + e.target.files.length + " files") }
</script></body>`

function WebViewLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ flex: 1, paddingHorizontal: 6, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={12} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export function WebViewLabScreen() {
  const status = signal("ready")
  const url = signal<string | undefined>(undefined)
  const html = signal<string | undefined>(undefined)
  const base = signal<string | undefined>(undefined)
  const uploads = signal(true)
  const web = webViewController()
  const say = (text: string) => {
    console.info(`webview-lab ${text}`)
    status.set(text)
  }
  console.info("webview-lab open") // not at the top of the file: imports run before installRuntime()

  const page = (to: string) => {
    html.set(undefined)
    base.set(undefined)
    url.set(to)
  }
  const inline = (baseUrl: string | undefined, page = INLINE) => {
    url.set(undefined)
    base.set(baseUrl)
    html.set(page)
  }
  const send = (text: string) => web.postMessage(text).then((r) => say(`sent: ${r.sent} ${r.reason ?? ""}`))
  const leaves = (link: { scheme: string; gesture: boolean }) => {
    say(`link out: ${link.scheme} gesture=${link.gesture}`)
    return link.scheme === "tel" // never a real UPI app from a test
  }

  return (
    <Column style={{ flex: 1, backgroundColor: c.white }}>
      <Text fontSize={12} color={c.ink} style={{ padding: 8 }}>
        {`status: ${status()}`}
      </Text>
      <Text fontSize={12} color={c.muted} style={{ paddingHorizontal: 8 }}>
        page below
      </Text>
      <Column style={{ height: 220 }}>
        <WebView
          controller={web}
          url={url()}
          html={html()}
          baseUrl={base()}
          headers={{ "x-zn-lab": "1" }}
          allowedHosts={HOSTS}
          leaveSchemes={LEAVE}
          fileUpload={uploads()}
          onReady={(r) => say(`ready bridge=${r.bridge} refused=${r.refused.length}`)}
          onLoadStart={(u) => say(`load start: ${u}`)}
          onLoadFinish={(p) => say(`load finish: ok=${p.ok} status=${p.status} title=${p.title}`)}
          onLoadError={(e) => say(`load error: ${e.kind} ${e.status ?? e.code ?? ""}`)}
          onProgress={(p) => p === 100 && say("progress: 100")}
          onTitle={(t) => say(`title: ${t}`)}
          onNavigate={(p) => say(`can go back: ${p.canGoBack}`)}
          onMessage={(m) => say(`message: ${m.text} from ${m.origin} main=${m.mainFrame}`)}
          onLinkOutside={leaves}
          onLinkRefused={(l) => say(`link refused: ${l.reason} ${l.url.slice(0, 60)}`)}
          onUpload={(n) => say(`upload answered: ${n}`)}
          onRenderGone={(g) => say(`render gone crashed=${g.crashed}`)}
          onPause={() => say("paused")}
          onResume={() => say("resumed")}
        />
      </Column>
      <Scroll style={{ flex: 1 }}>
        <Column gap={8} style={{ padding: 10 }}>
          <Row gap={8}>
            <WebViewLabButton label="Load inline" onPress={() => inline(BASE)} />
            <WebViewLabButton label="Inline no base" onPress={() => inline(undefined)} />
            <WebViewLabButton label="Load page" onPress={() => page(`${SERVER}/page`)} />
          </Row>
          <Row gap={8}>
            <WebViewLabButton label="Tap tel page" onPress={() => page(`${SERVER}/page?tap=tel`)} />
            <WebViewLabButton label="Tap file page" onPress={() => page(`${SERVER}/page?tap=file`)} />
            <WebViewLabButton label="Load blocked" onPress={() => page(`${BLOCKED}/page`)} />
          </Row>
          <Row gap={8}>
            <WebViewLabButton label="Load missing" onPress={() => page("http://localhost:8791/")} />
            <WebViewLabButton label="Load 500" onPress={() => page(`${SERVER}/status/500`)} />
            <WebViewLabButton label="Set cookie" onPress={() => page(`${SERVER}/cookie-set`)} />
          </Row>
          <Row gap={8}>
            <WebViewLabButton label="Show cookie" onPress={() => page(`${SERVER}/cookie`)} />
            <WebViewLabButton label="Clear cookies" onPress={() => void WebViewNative.clearCookies().then((r) => say(`cookies cleared: ${r}`))} />
            <WebViewLabButton label="Clear storage" onPress={() => void WebViewNative.clearStorage().then(() => say("storage cleared"))} />
          </Row>
          <Row gap={8}>
            <WebViewLabButton label="Send message" onPress={() => send("echo:hi from app")} />
            <WebViewLabButton label="Go inside" onPress={() => send(`go:${SERVER}/page2`)} />
            <WebViewLabButton label="Go blocked" onPress={() => send(`go:${BLOCKED}/page2`)} />
          </Row>
          <Row gap={8}>
            <WebViewLabButton label="Go redirect" onPress={() => send(`go:${SERVER}/redirect-out`)} />
            <WebViewLabButton label="Post form" onPress={() => send("post-form")} />
            <WebViewLabButton label="Go upi" onPress={() => send("go:upi://pay?pa=test@mock&pn=Lab&am=1.00&cu=INR")} />
          </Row>
          <Row gap={8}>
            <WebViewLabButton label="Go intent" onPress={() => send("go:intent://x#Intent;scheme=https;component=dev.zeronative.sample/.MainActivity;S.a=b;end")} />
            <WebViewLabButton label="Go file" onPress={() => send("go:file:///data/data/dev.zeronative.sample/shared_prefs/x.xml")} />
            <WebViewLabButton label="Go content" onPress={() => send("go:content://dev.zeronative.sample.none/x")} />
          </Row>
          <Row gap={8}>
            <WebViewLabButton label="Page back" onPress={() => void web.back().then((r) => say(`back: ${r}`))} />
            <WebViewLabButton label="Reload" onPress={() => void web.reload().then((r) => say(`reload: ${r}`))} />
            <WebViewLabButton label="Open fake screen" onPress={() => void nav.pushForResult("fakeScreen", { title: "Web" }).then(() => say("fake closed"))} />
          </Row>
          <Row gap={8}>
            <WebViewLabButton label="Inline upload" onPress={() => inline(BASE, UPLOAD)} />
            <WebViewLabButton label="Upload, no base" onPress={() => inline(undefined, UPLOAD)} />
            <WebViewLabButton label="Share (covers)" onPress={() => void Os.share({ text: "webview lab" }).then((r) => say(`share closed: ${r}`))} />
          </Row>
          <Row gap={8}>
            <WebViewLabButton
              label={uploads() ? "Uploads: on" : "Uploads: off"}
              onPress={() => {
                uploads.set(!uploads())
                say(`file upload ${uploads()}`)
              }}
            />
            <WebViewLabButton label="Crash renderer" onPress={() => void web.debugRenderer("crash").then((r) => say(`crash asked: ${r}`))} />
            <WebViewLabButton label="Kill renderer" onPress={() => void web.debugRenderer("terminate").then((r) => say(`kill asked: ${r}`))} />
          </Row>
        </Column>
      </Scroll>
    </Column>
  )
}

// A local server for the webview phone test. tools/plugin-phone/webview.ts starts it by itself. To use the lab by hand:
//
//   bun run tools/plugin-phone/webview-server.ts
//   adb reverse tcp:8790 tcp:8790
//
// One server, two names: the lab allows http://localhost:8790, and http://127.0.0.1:8790 stands for a host it doesn't allow.
const PORT = 8790
export const ALLOWED = `http://localhost:${PORT}`
export const BLOCKED = `http://127.0.0.1:${PORT}`

/** What reached the server, to prove a blocked request never left the phone. */
export const received = { sink: 0, upload: 0 }

// Commands come from the app as messages: this page is what obeys them. "go:" lets a test follow a link with no tap.
const script = (path: string) => `
var send = function (t) { window.ZeroNative && ZeroNative.postMessage(t) }
if (window.ZeroNative) ZeroNative.addEventListener("message", function (e) {
  var t = e.data
  if (t.indexOf("echo:") === 0) send("echo " + t.slice(5))
  if (t.indexOf("go:") === 0) location.href = t.slice(3)
  if (t === "post-form") document.getElementById("form").submit()
  if (t === "cookie") send("cookie: " + (document.cookie || "none"))
})
window.addEventListener("message", function (e) { if (e.data && String(e.data).indexOf("frame bridge") === 0) send(e.data) })
document.title = "lab ${path}"
send("ready ${path}")
if (${path === "/cookie" || path === "/cookie-set"}) send("cookie: " + (document.cookie || "none"))
var file = document.getElementById("file")
if (file) {
  file.addEventListener("cancel", function () { send("file cancelled") })
  file.addEventListener("change", function () {
    var f = file.files[0]
    if (!f) return send("file none")
    fetch("/upload", { method: "POST", body: f }).then(function () { send("file sent: " + f.size + " bytes") })
  })
}
`

const zone = "display:block;height:110px;line-height:110px;text-align:center;background:#3D26ED;color:#fff;font:bold 20px sans-serif;text-decoration:none"

function tapZone(tap: string | null) {
  if (tap === "tel") return `<a href="tel:+911234567890" style="${zone}">Call</a>`
  if (tap === "file") return `<label style="${zone}">Choose file<input id="file" type="file" style="display:none"></label>`
  return `<a href="/page2" style="${zone}">Inside</a>`
}

const page = (path: string, tap: string | null) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;font:16px sans-serif">
${tapZone(tap)}
<p>zero-native lab ${path}</p>
<form id="form" method="post" action="${BLOCKED}/sink"><input name="secret" value="typed by the user"></form>
${path === "/page" ? `<iframe src="${BLOCKED}/frame" style="width:100%;height:40px;border:0"></iframe>` : ""}
<script>${script(path)}</script>
</body></html>`

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } })

/** A host the app didn't allow, in an iframe of an allowed page. It tells its parent if it has the bridge. */
const frame = `<!doctype html><script>parent.postMessage("frame bridge " + typeof window.ZeroNative, "*")</script>`

export function startWebViewServer() {
  return Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      if (path === "/page" || path === "/page2" || path === "/cookie") return html(page(path, url.searchParams.get("tap")))
      if (path === "/cookie-set") return html(page(path, null), { "set-cookie": "zn_lab=kept; Max-Age=86400; Path=/" })
      if (path === "/frame") return html(frame)
      if (path === "/redirect-out") return new Response(null, { status: 302, headers: { location: `${BLOCKED}/page` } })
      if (path === "/status/500") return new Response("server error", { status: 500 })
      if (path === "/sink") {
        received.sink++
        return new Response("the form reached a blocked host")
      }
      if (path === "/upload") {
        received.upload++
        return new Response(`got ${(await req.arrayBuffer()).byteLength}`)
      }
      return new Response("not found", { status: 404 })
    },
  })
}

if (import.meta.main) {
  startWebViewServer()
  console.log(`webview test server: ${ALLOWED}`)
  console.log(`on the phone: adb reverse tcp:${PORT} tcp:${PORT}`)
}

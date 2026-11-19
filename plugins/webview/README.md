# @zeronative/webview

A web page inside a screen: cookies, file upload, messages both ways, and which links leave the app.

A page is outside input. So this plugin refuses by default: only hosts you list load, only https, and nothing leaves the app unless your code says so.

## Add it

1. `package.json`: add `"@zeronative/webview": "workspace:*"`.
2. `android/settings.gradle.kts`: include `:plugin-webview` and set its `projectDir` (`docs/guide-notes.md` §30).
3. The app's `build.gradle.kts`: `implementation(project(":plugin-webview"))`.
4. `Application.onCreate`, first thing: `ZnPlugins.register(this, WebViewPlugin())`.

The host needs the `INTERNET` permission and `ZnActivity.attach(this)` in `onCreate`.

## Use it

```tsx
import { Column } from "@zeronative/ui"
import { WebView, webViewController } from "@zeronative/webview"

export function HelpScreen() {
  const web = webViewController()
  return (
    <Column style={{ flex: 1 }}>
      <WebView
        controller={web}
        url="https://help.example.com/start"
        allowedHosts={["help.example.com", "*.cdn.example.com"]}
        leaveSchemes={["tel", "mailto"]}
        onMessage={(m) => console.info(m.text)}
        onLinkOutside={(link) => link.gesture}
        onRenderGone={() => web.reload()}
      />
    </Column>
  )
}
```

`WebView` fills the Column around it, so size that Column. Don't put it in a `Scroll`.

In the page:

```js
ZeroNative.addEventListener("message", (e) => console.log(e.data))
ZeroNative.postMessage("hello")
```

The page must post one message first. That message is what opens the way back to it.

## API

**Props:** `url`, `html`, `baseUrl`, `headers`, `allowedHosts` (required), `leaveSchemes`, `javaScript` (true), `thirdPartyCookies` (false), `fileUpload` (true), `backInPage` (true).

**Events:** `onReady`, `onLoadStart`, `onLoadFinish`, `onLoadError`, `onProgress`, `onTitle`, `onNavigate`, `onMessage`, `onLinkOutside`, `onLinkRefused`, `onUpload`, `onRenderGone`, `onPause`, `onResume`. The types in `src/api.ts` say what each one carries.

**`webViewController()`:** `back()`, `reload()`, `postMessage(text)`, `openLink(url)`, `view()`.

**`WebViewNative`:** `clearCookies()`, `clearStorage()`. Call both at logout: localStorage is not a cookie.

`allowedHosts` takes `pay.example.com`, `port.example:8443` and `*.example.com` (what is under the name, not the name itself). A debug build can also use `http://localhost:8790` or `http://127.0.0.1:8790`. `*` and `*.com` are refused. `onReady` lists any entry that was dropped.

`onLinkOutside` answers true to open the link. With no handler, nothing leaves.

## Security

| Choice | Why |
|---|---|
| Hosts: nothing loads unless listed, in `url`, `baseUrl`, links, redirects and form posts | A redirect or a link must not walk the page off your list |
| https only. Plain http only to this computer, in debug builds | http can be changed on the way |
| The bridge is `addWebMessageListener` with your hosts as origins, not `addJavascriptInterface` | WebView itself keeps the object out of other origins, also in iframes and after a redirect. A JavascriptInterface goes into every frame of every page |
| Each message's origin is checked again in Kotlin | Two locks, and the list can change after a page loaded |
| No bridge on a WebView too old for it. No fallback | A weaker bridge is worse than none. `onReady` says `bridge: false` |
| Messages are text only, 64 KB at most | The bigger one is dropped, not cut |
| JS → page goes by the reply path of that page | It only reaches that page, so a late send can't land on the next one |
| No `evaluate` | Script built from text in the app can hand a page's login to whoever wrote the text. Messages do the job |
| Links out are a question to your JS, and `openLink` checks the rule again | A page can't open another app by itself. The answer has `gesture`, so you can refuse what no one tapped |
| Links out: at most one in 800 ms, and only from the main frame | A loop must not trap the user. An iframe must not open an app |
| The Intent is `ACTION_VIEW` + `BROWSABLE` + the link, nothing else | No extras, target app or flags from the page |
| `intent:` and `android-app:` are always refused, even if you list them | They can name any Activity in any app, with any extras. Plain `upi:` works |
| `file:`, `content:`, `javascript:`, `data:`, `blob:`, `about:` never open as pages | File access and content access are off too |
| Mixed content off | No http inside an https page |
| Third-party cookies off unless you ask | Trackers |
| A bad certificate always stops the page | There is no option to pass it, not even in debug |
| Picked files: `content:` from other apps only | A bad picker can name `file:` paths or our own provider to read our private files |
| File upload only from an allowed host | The picker is a strong thing to give a page |
| Safe browsing on, form saving off, location off | Camera and mic requests are denied (WebView's default) |
| Debugging only in debug builds, and only with `WebViewPlugin(inspect = true)`. The page's console only in debug builds | A console can print tokens. Off by default, as in react-native-webview |
| Logs show the host only | A link can carry a token |
| JavaScript is on by default | A page with no script can't use the bridge, and most pages break. The hosts list is what keeps it safe. Turn it off with `javaScript={false}` |

## How it behaves

**Commands** are module functions, not a counter in props. Props are state: they run again when the view is made again, and two in one tick become one.

**Back:** the view has a Compose `BackHandler`, on only while the page can go back and the view's screen is in front. So system Back goes back in the page first, before `useBack`. Set `backInPage={false}` to do it yourself with `useBack` and `controller.back()`.

**Upload** uses the Activity's result registry, not `ZnLaunch`. WebView's callback lives in memory, so a kill loses it and durable records don't help. The callback is always answered: with the files, with null on cancel, and with null if the view closes. After a kill, the restored screen loads its page again and the user picks again.

**Lifecycle:** `onPause` and `onResume` follow the screen. `pauseTimers` stops every WebView in the app, so it follows the app. Cookies are written to disk at each stop.

**Renderer crash:** the app lives. `onRenderGone` fires, the view goes empty, and `controller.reload()` makes a new one.

## Limits

- A new screen on top drops the WebView: only the top screen is composed. Coming back makes a new one and loads `url` again, so the page's own state and history are gone. Cookies stay.
- After a kill, only the `url` prop comes back, not where the user was.
- `headers` go with the first request only.
- Session cookies don't live through a kill. A server must set `Max-Age` or `Expires`.
- Changing `allowedHosts` changes the bridge from the next page load. The Kotlin check drops messages at once.
- An iframe from another host still loads. It has no bridge and can't leave.
- `shouldOverrideUrlLoading` doesn't see subresources: a listed page can still fetch from any https host.
- Android 7 has no `onRenderProcessGone`, so a renderer crash there can kill the app.
- A form post that is refused shows an empty page, then `about:blank`.
- A POST that a server on an allowed host redirects (307) to another host is caught only as the page starts. By then the other host has the request. Only pages from your own hosts can do this.
- A page's camera capture (`<input capture>`), folders and fullscreen video are not supported. `upi:` opens the app with no result: for a payment result, write a plugin on `ZnLaunch`.
- Android only.

## Size

| Dependency | Version | Size |
|---|---|---|
| `androidx.webkit:webkit` | 1.15.0 | 256 KB AAR (277 KB of classes before R8, and a release build keeps only what is used) |
| `androidx.activity:activity-compose` | 1.13.0 | Already in every app |

The WebView itself comes with the phone. Measured in the sample's R8 release, 2026-11-03 (Play download with the brotli method in `docs/startup-and-performance.md` §3): about 19 KB of classes with `androidx.webkit`, about 10 KB of download.

## Test

`bun test plugins/webview`, `gradlew :plugin-webview:testDebugUnitTest`, and on a phone `bun run tools/plugin-phone.ts webview`.

// The zn-updates dashboard (docs/zn-updates-server.md §6). Hash routes (#/bundles, #/bundles/12), so the server needs
// no extra routes. The private key is loaded by the owner and lives in this tab's memory only.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { type AppRecord, ApiError, type Auth, onSessionEnd, routes, save, saved, type State } from "./api"
import { DialogHost } from "./dialogs"
import { Activity, Environment, Phones } from "./pages-more"
import { BundlePage, Bundles, Overview, serialFromRoute } from "./pages-bundles"
import { Channels, StoreBuilds, StoreUpdates } from "./pages-store"
import type { SigningKey } from "./sign"
import { AppCtx, Btn, type Ctx, type DialogSpec, Empty, ErrorBox, Icon, Skeleton } from "./ui"

const NAV: { id: string; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "home" },
  { id: "bundles", label: "Bundles", icon: "box" },
  { id: "channels", label: "Channels", icon: "flow" },
  { id: "store", label: "Store updates", icon: "store" },
  { id: "builds", label: "Store builds & families", icon: "build" },
  { id: "phones", label: "Phones", icon: "phone" },
  { id: "activity", label: "Activity", icon: "list" },
  { id: "env", label: "Environment", icon: "gear" },
]

function parseHash() {
  const h = location.hash.replace(/^#/, "")
  const [path = "", query = ""] = h.split("?")
  const segs = path.split("/").filter(Boolean)
  return { page: segs[0] ?? "overview", id: segs[1], app: new URLSearchParams(query).get("app") ?? "" }
}

function useRoute() {
  const [r, setR] = useState(parseHash)
  useEffect(() => {
    const on = () => setR(parseHash())
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])
  return r
}

// ---- Signed out ------------------------------------------------------------------------------------------------------

/** No session (it ended, or you signed out). The dashboard is opened from the terminal only: no token field here. */
function SignedOut({ note }: { note?: string }) {
  return (
    <div className="signin">
      <div className="card signin-card">
        <div className="logo big">zn</div>
        <h1>zn updates</h1>
        <p className="sub">{note || "You are signed out."}</p>
        <p className="sub">
          To open the dashboard, run this in your app's folder:
        </p>
        <pre className="cmd">bun run ../../Futuristic/zero-native/tools/updates/cli.ts dashboard</pre>
        <p className="sub small">It signs this browser in for 12 hours. Your admin token stays in the terminal.</p>
      </div>
    </div>
  )
}

// ---- Shell ------------------------------------------------------------------------------------------------------------

interface Toast {
  id: number
  text: string
  kind: "ok" | "error"
}

function Shell({ auth, onSignOut }: { auth: Auth; onSignOut: (why?: string) => void }) {
  const route = useRoute()
  const [apps, setApps] = useState<AppRecord[] | null>(null)
  const [appsError, setAppsError] = useState("")
  const [state, setState] = useState<State | null>(null)
  const [stateError, setStateError] = useState("")
  const [rev, setRev] = useState(0)
  const [key, setKey] = useState<SigningKey | null>(null)
  const [dialog, setDialog] = useState<DialogSpec | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)

  const loadApps = useCallback(async () => {
    setAppsError("")
    try {
      setApps(await routes.apps())
    } catch (e) {
      setAppsError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void loadApps()
  }, [loadApps])

  const appId = useMemo(() => {
    if (!apps || apps.length === 0) return ""
    const want = route.app || saved("znu.app")
    return apps.some((a) => a.id === want) ? want : apps[0]!.id
  }, [apps, route.app])
  useEffect(() => {
    if (appId) save("znu.app", appId)
  }, [appId])

  const reload = useCallback(async () => {
    if (!appId) return
    try {
      setState(await routes.state(appId))
      setStateError("")
      setRev((r) => r + 1)
    } catch (e) {
      setStateError((e as Error).message)
    }
  }, [appId])
  useEffect(() => {
    setState(null)
    void reload()
  }, [reload])

  const toast = useCallback((text: string, kind: "ok" | "error" = "ok") => {
    const id = ++toastId.current
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 3500)
  }, [])

  const href = useCallback((path: string) => `#${path}${appId ? `?app=${encodeURIComponent(appId)}` : ""}`, [appId])
  const go = useCallback((path: string) => {
    location.hash = href(path)
  }, [href])
  const close = useCallback(() => setDialog(null), [])
  const keyOk = !!key && !!state && state.app.publicKeys.includes(key.publicKey)

  const ctx: Ctx = { appId, state, rev, reload, key, setKey, keyOk, toast, open: setDialog, close, href, go, user: auth.name }

  // Close an open dialog when the page changes.
  useEffect(() => setDialog(null), [route.page, route.id])

  const page = route.page
  let body
  if (appsError) body = <ErrorBox error={appsError} retry={() => void loadApps()} />
  else if (!apps) body = <Skeleton rows={5} />
  else if (apps.length === 0) body = <Empty title="No apps yet">Create one with the CLI (bun run updates app) or POST /admin/apps.</Empty>
  else if (stateError && !state) body = <ErrorBox error={stateError} retry={() => void reload()} />
  else if (!state) body = <Skeleton rows={6} />
  else if (page === "bundles") {
    const serial = route.id ? serialFromRoute(route.id) : null
    body = route.id ? serial ? <BundlePage serial={serial} /> : <Empty title="That is not a bundle number" /> : <Bundles />
  } else if (page === "channels") body = <Channels />
  else if (page === "store") body = <StoreUpdates />
  else if (page === "builds") body = <StoreBuilds />
  else if (page === "phones") body = <Phones />
  else if (page === "activity") body = <Activity />
  else if (page === "env") body = <Environment />
  else body = <Overview />

  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell">
        <header className="topbar">
          <a className="brand" href={href("/overview")}>
            <span className="logo">zn</span>
            <span className="brand-name">updates</span>
          </a>
          <div className="topbar-right">
            {apps && apps.length > 0 ? (
              <select className="app-pick" value={appId} aria-label="App" onChange={(e) => (location.hash = `#/${page}${route.id ? `/${route.id}` : ""}?app=${encodeURIComponent(e.target.value)}`)}>
                {apps.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            ) : null}
            <button type="button" className={`keychip ${key ? (keyOk ? "ok" : "bad") : ""}`} onClick={() => setDialog({ t: "key" })} title="Signing key for this tab">
              <Icon n="key" size={16} />
              <span>{key ? (keyOk ? key.keyId.slice(0, 8) : "Wrong key") : "Load key"}</span>
            </button>
            <button type="button" className="btn ghost small icon" aria-label="Refresh" title="Refresh" onClick={() => void reload()}>
              <Icon n="refresh" />
            </button>
            <button type="button" className="btn ghost small who" title="Sign out" onClick={() => onSignOut()}>
              {auth.name}
            </button>
          </div>
        </header>
        <nav className="nav" aria-label="Pages">
          {NAV.map((n) => (
            <a key={n.id} href={href(`/${n.id}`)} className={page === n.id || (n.id === "overview" && !NAV.some((x) => x.id === page)) ? "on" : ""}>
              <Icon n={n.icon} size={18} />
              <span>{n.label}</span>
            </a>
          ))}
        </nav>
        <main className="main">
          {stateError && state ? <ErrorBox error={stateError} retry={() => void reload()} /> : null}
          {body}
        </main>
      </div>
      {state ? <DialogHost spec={dialog} /> : dialog?.t === "key" ? <DialogHost spec={dialog} /> : null}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </AppCtx.Provider>
  )
}

function Root() {
  // undefined: asking the server; null: no session
  const [auth, setAuthState] = useState<Auth | null | undefined>(undefined)
  const [note, setNote] = useState("")
  useEffect(() => {
    save("znu.token", "") // older dashboards kept the admin token here: remove it
    routes
      .session()
      .then((s) => setAuthState({ name: s.by, expiresAt: s.expiresAt }))
      .catch(() => setAuthState(null))
  }, [])
  const signOut = useCallback((why?: string) => {
    void routes.logout().catch(() => {})
    setNote(why ?? "")
    setAuthState(null)
  }, [])
  useEffect(() => {
    onSessionEnd(() => {
      setNote("Your session ended.")
      setAuthState(null)
    })
  }, [])
  if (auth === undefined) return null
  if (!auth) return <SignedOut note={note} />
  return <Shell auth={auth} onSignOut={signOut} />
}

createRoot(document.getElementById("root")!).render(<Root />)

// Shared parts: the app context, small components, dialogs' frame, hooks.
import { createContext, type CSSProperties, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react"
import type { Os, Rule, State } from "./api"
import type { SigningKey } from "./sign"
import { ago, copy as copyText, dateTime } from "./util"

// ---- The app context --------------------------------------------------------------------------------------------------

export type DialogSpec =
  | { t: "change"; mode: "publish" | "rollback" | "rollout" | "kill"; channel: string; serial?: number }
  | { t: "stable"; serial: number; on: boolean }
  | { t: "title"; serial: number }
  | { t: "delete"; serial: number; on: boolean }
  | { t: "storeBuild"; id: number; mode: "live" | "unlive" | "delete" | "undo" }
  | { t: "rule"; os: Os; channel: string; rule?: Rule }
  | { t: "ruleDelete"; os: Os; rule: Rule }
  | { t: "key" }

export interface Ctx {
  appId: string
  state: State | null
  /** Changes after every reload: pages use it to load their own data again. */
  rev: number
  reload: () => Promise<void>
  key: SigningKey | null
  setKey: (k: SigningKey | null) => void
  /** True when a key is loaded and is one of the app's public keys. */
  keyOk: boolean
  toast: (text: string, kind?: "ok" | "error") => void
  open: (d: DialogSpec) => void
  close: () => void
  /** A link that keeps the selected app. */
  href: (path: string) => string
  go: (path: string) => void
  user: string
}

export const AppCtx = createContext<Ctx | null>(null)
export function useApp(): Ctx {
  const c = useContext(AppCtx)
  if (!c) throw new Error("no app context")
  return c
}

// ---- Loading hook -----------------------------------------------------------------------------------------------------

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [st, set] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true })
  const [n, setN] = useState(0)
  const fnRef = useRef(fn)
  fnRef.current = fn
  // biome-ignore lint: deps are given by the caller
  useEffect(() => {
    let live = true
    set((s) => ({ ...s, loading: true, error: undefined }))
    fnRef.current().then(
      (data) => live && set({ data, loading: false }),
      (e: Error) => live && set((s) => ({ ...s, error: e.message, loading: false })),
    )
    return () => {
      live = false
    }
  }, [...deps, n])
  const reload = useCallback(() => setN((x) => x + 1), [])
  return { ...st, reload }
}

// ---- Icons ------------------------------------------------------------------------------------------------------------

const PATHS: Record<string, string> = {
  check: "M5 13l4 4L19 7",
  x: "M6 6l12 12M18 6L6 18",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  copy: "M9 9h10v10H9zM5 15V5h10",
  refresh: "M20 11a8 8 0 10-2.3 5.7M20 4v7h-7",
  key: "M15 7a4 4 0 11-3.9 4.9L4 19v-3h3v-3h3l1.1-1.1A4 4 0 0115 7z",
  alert: "M12 4l9 16H3zM12 10v4M12 17h.01",
  info: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v5M12 8h.01",
  back: "M15 5l-7 7 7 7",
  home: "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
  box: "M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8",
  flow: "M5 6h6a3 3 0 013 3v6a3 3 0 003 3h2M17 15l2 3-2 3",
  store: "M4 9l1-5h14l1 5M4 9v11h16V9M9 20v-6h6v6",
  phone: "M8 3h8a1 1 0 011 1v16a1 1 0 01-1 1H8a1 1 0 01-1-1V4a1 1 0 011-1zM11 18h2",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  gear: "M12 9a3 3 0 100 6 3 3 0 000-6zM19 12l2-1-2-4-2 .5-1.5-1L15 4h-4l-.5 2.5-1.5 1L7 7 5 11l2 1v2l-2 1 2 4 2-.5 1.5 1L11 20h4l.5-2.5 1.5-1 2 .5 2-4-2-1z",
  build: "M4 20h16M6 20V10l6-6 6 6v10M10 20v-5h4v5",
}
export function Icon({ n, size = 18 }: { n: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={n === "more" ? 4 : 2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[n] ?? ""} />
    </svg>
  )
}

// ---- Small parts ------------------------------------------------------------------------------------------------------

type Tone = "grey" | "brand" | "blue" | "green" | "red" | "amber"
export function Badge({ tone = "grey", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {children}
    </span>
  )
}

export function Btn(p: {
  children: ReactNode
  onClick?: () => void
  kind?: "primary" | "ghost" | "danger" | "soft"
  small?: boolean
  disabled?: boolean
  title?: string
  type?: "button" | "submit"
  busy?: boolean
}) {
  return (
    <button
      type={p.type ?? "button"}
      className={`btn ${p.kind ?? "soft"}${p.small ? " small" : ""}`}
      onClick={p.onClick}
      disabled={p.disabled || p.busy}
      title={p.title}
    >
      {p.busy ? "Working…" : p.children}
    </button>
  )
}

/** "2 h ago", with the full local date on hover. */
export function When({ at }: { at: string }) {
  return <span title={dateTime(at)}>{ago(at)}</span>
}

export function Card({ children, className = "", title, right }: { children: ReactNode; className?: string; title?: ReactNode; right?: ReactNode }) {
  return (
    <section className={`card ${className}`}>
      {title || right ? (
        <header className="card-head">
          <h3>{title}</h3>
          <div className="card-right">{right}</div>
        </header>
      ) : null}
      {children}
    </section>
  )
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk-row" style={{ width: `${95 - i * 12}%` }} />
      ))}
    </div>
  )
}

export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="notice red" role="alert">
      <Icon n="alert" />
      <div className="grow">{error}</div>
      {retry ? (
        <Btn small onClick={retry}>
          Try again
        </Btn>
      ) : null}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  )
}

export function Notice({ tone = "amber", children }: { tone?: "amber" | "red" | "blue" | "green"; children: ReactNode }) {
  return (
    <div className={`notice ${tone}`}>
      <Icon n={tone === "green" ? "check" : tone === "blue" ? "info" : "alert"} />
      <div className="grow">{children}</div>
    </div>
  )
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "red" | "green" }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ?? ""}`}>{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  )
}

export function PageHead({ title, sub, right, back }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="page-head">
      <div>
        {back ? (
          <a className="back" href={back.href}>
            <Icon n="back" size={14} /> {back.label}
          </a>
        ) : null}
        <h1>{title}</h1>
        {sub ? <p className="sub">{sub}</p> : null}
      </div>
      <div className="page-head-right">{right}</div>
    </div>
  )
}

export function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="tablist">
      {options.map(([v, label]) => (
        <button key={String(v)} type="button" role="tab" aria-selected={v === value} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

/** A block of text with a copy button (commands, stacks). */
export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const { toast } = useApp()
  return (
    <div className="copyblock">
      {label ? <div className="copyblock-label">{label}</div> : null}
      <pre>{text}</pre>
      <button type="button" className="btn ghost small" onClick={async () => toast((await copyText(text)) ? "Copied" : "Could not copy: select the text and copy it yourself", "ok")}>
        <Icon n="copy" size={14} /> Copy
      </button>
    </div>
  )
}

/** The "⋯" menu for the less used row actions. */
export function Menu({ items }: { items: { label: string; onClick: () => void; disabled?: boolean; why?: string; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", away)
    document.addEventListener("keydown", esc, true)
    return () => {
      document.removeEventListener("mousedown", away)
      document.removeEventListener("keydown", esc, true)
    }
  }, [open])
  if (items.length === 0) return null
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="btn ghost small icon outline" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon n="more" />
      </button>
      {open ? (
        <div className="menu-pop" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={it.danger ? "danger" : ""}
              disabled={it.disabled}
              title={it.disabled ? it.why : undefined}
              onClick={() => {
                setOpen(false)
                it.onClick()
              }}
            >
              <span>{it.label}</span>
              {it.disabled && it.why ? <small>{it.why}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ---- Dialog frame -----------------------------------------------------------------------------------------------------

export function Modal({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", esc)
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", esc)
      document.body.style.overflow = prev
    }
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <header className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="btn ghost small icon" aria-label="Close" onClick={onClose}>
            <Icon n="x" />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer ? <footer className="sheet-foot">{footer}</footer> : null}
      </div>
    </div>
  )
}

export function Field({ label, hint, children, counter }: { label: string; hint?: ReactNode; children: ReactNode; counter?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {counter ? <span className="counter">{counter}</span> : null}
      </span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  )
}

/** The CSS variable a needs colour sets (styles.css: .needs-tag, the .brow[data-needs] ribbon). */
export function needsVar(colour: number): CSSProperties {
  return { ["--needs" as string]: `var(--needs-${colour})` }
}

/**
 * A bundle's needs tag (server model.ts needsTag) in its colour: the same colour and tag = the same needs (every module,
 * both OSes). [same]: the other bundle numbers with these needs, for the tooltip.
 */
export function NeedsTag({ tag, colour, same }: { tag: string; colour: number; same: number[] }) {
  const title = same.length
    ? `Same needs as ${same.map((n) => `#${n}`).join(", ")}: these bundles need exactly the same native modules and versions`
    : "No other bundle needs exactly these native modules and versions"
  return (
    <span className="needs-tag" style={needsVar(colour)} title={title}>
      <span className="needs-dot" />
      needs {tag}
    </span>
  )
}

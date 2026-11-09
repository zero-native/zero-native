// Overview, Bundles and the bundle page.
import { useMemo, useState } from "react"
import { type Bundle, routes, type State, type Stats } from "./api"
import { bundleActions, cannotRun, channelNow, type ChannelNow, nextHints, PRODUCTION, STAGING } from "./logic"
import { Badge, Btn, Card, Empty, ErrorBox, Menu, Notice, PageHead, Segmented, Skeleton, Stat, useApp, useLoad, When } from "./ui"
import { actionWords, ago, bytes, dateTime, kindWords, requiresList, targetLabel } from "./util"

export function todayUtc() {
  return new Date().toISOString().slice(0, 10)
}
export function phonesToday(st: Stats | undefined): number {
  if (!st) return 0
  const t = todayUtc()
  return st.phones.filter((p) => p.day === t).reduce((n, p) => n + p.phones, 0)
}
export function errorScreens(st: Stats | undefined): number {
  return st ? st.events.filter((e) => e.kind === "error_screen").reduce((n, e) => n + e.count, 0) : 0
}

export function ChannelTag({ name }: { name: string }) {
  return <Badge tone={name === PRODUCTION ? "brand" : "blue"}>{name}</Badge>
}

/** One line in words: what a channel serves. */
export function servesText(n: ChannelNow): string {
  if (n.empty) return "Nothing published yet. Phones run the app's own bundle."
  if (n.killed) return "Kill switch is on. Phones run the app's own bundle."
  return `Phones get #${n.serial}, for ${n.rollout}% of phones.`
}

// ---- Overview ---------------------------------------------------------------------------------------------------------

function ChannelCard({ s, name }: { s: State; name: string }) {
  const c = useApp()
  const n = channelNow(s, name)
  const st = useLoad(() => routes.stats(s.app.id, name, 1), [s.app.id, name, c.rev])
  return (
    <Card className={`channel-card ${name}`}>
      <div className="cc-top">
        <ChannelTag name={name} />
        {n.killed ? <Badge tone="red">Kill switch ON</Badge> : n.empty ? <Badge>Empty</Badge> : <Badge tone="green">Live</Badge>}
      </div>
      <div className="cc-big">
        {n.killed ? <span className="muted-big">Built-in</span> : n.serial !== null ? <a href={c.href(`/bundles/${n.serial}`)}>#{n.serial}</a> : <span className="muted-big">None</span>}
        {n.serial !== null ? <span className="cc-pct">{n.rollout}%</span> : null}
      </div>
      <p className="sub">{servesText(n)}</p>
      <dl className="facts">
        <dt>Priority</dt>
        <dd>{n.priority === "high" ? "High" : "Normal"}</dd>
        <dt>Change number</dt>
        <dd className="num">{n.seq || "none"}</dd>
        <dt>Last change</dt>
        <dd>{n.at ? <><When at={n.at} /> by {n.by}</> : "never"}</dd>
        {n.reason ? (
          <>
            <dt>Reason</dt>
            <dd>{n.reason}</dd>
          </>
        ) : null}
      </dl>
      <div className="cc-stats">
        <div>
          <div className="stat-label">Phones today</div>
          <div className="stat-value small num">{st.loading && !st.data ? "…" : st.error ? "?" : phonesToday(st.data)}</div>
        </div>
        <div>
          <div className="stat-label">Error screens today</div>
          <div className={`stat-value small num ${errorScreens(st.data) > 0 ? "red" : ""}`}>{st.loading && !st.data ? "…" : st.error ? "?" : errorScreens(st.data)}</div>
        </div>
      </div>
      <a className="link" href={c.href("/channels")}>
        Open {name}
      </a>
    </Card>
  )
}

export function Overview() {
  const c = useApp()
  const s = c.state!
  const act = useLoad(() => routes.activity(s.app.id, undefined, 8), [s.app.id, c.rev])
  const hints = nextHints(s, c.keyOk)
  const stable = s.bundles.filter((b) => b.stableAt).length
  const rules = s.rules.android.length + s.rules.ios.length
  return (
    <>
      <PageHead title="Overview" sub={`What phones get right now for ${s.app.name}.`} />
      {hints.length ? (
        <div className="hints">
          {hints.map((h) => (
            <Notice key={h.text} tone={h.tone}>
              {h.to ? <a href={c.href(h.to)}>{h.text}</a> : h.text}
            </Notice>
          ))}
        </div>
      ) : null}
      <div className="grid two">
        <ChannelCard s={s} name={STAGING} />
        <ChannelCard s={s} name={PRODUCTION} />
      </div>
      <div className="grid stats">
        <Stat label="Bundles" value={s.bundles.length} sub={`${stable} stable`} />
        <Stat label="Store builds" value={s.storeBuilds.length} sub={`${s.families.length} app build ${s.families.length === 1 ? "family" : "families"}`} />
        <Stat label="Store rules" value={rules} sub={`${s.rules.android.length} Play, ${s.rules.ios.length} App Store`} />
        <Stat label="Public keys" value={s.app.publicKeys.length} sub="can sign for this app" />
      </div>
      <Card title="Recent activity" right={<a className="link" href={c.href("/activity")}>See all</a>}>
        {act.loading && !act.data ? (
          <Skeleton rows={4} />
        ) : act.error ? (
          <ErrorBox error={act.error} retry={act.reload} />
        ) : act.data && act.data.length ? (
          <ul className="feed">
            {act.data.map((a) => {
              const w = actionWords(a)
              return (
                <li key={a.id}>
                  <div>
                    <strong>{w.title}</strong> <span className="muted">{w.detail}</span>
                  </div>
                  <div className="muted small">
                    {a.by}, <When at={a.at} />
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <Empty title="Nothing has happened yet" />
        )}
      </Card>
    </>
  )
}

// ---- Bundles ----------------------------------------------------------------------------------------------------------

export function BundleBadges({ s, b }: { s: State; b: Bundle }) {
  const lacking = cannotRun(s, b)
  return (
    <div className="badges">
      {b.liveOn.includes(STAGING) ? <Badge tone="blue">Live on staging</Badge> : null}
      {b.liveOn.includes(PRODUCTION) ? <Badge tone="brand">Live on production</Badge> : null}
      {b.everOn.includes(PRODUCTION) && !b.liveOn.includes(PRODUCTION) ? <Badge title="Production served it before">Was on production</Badge> : null}
      {b.stableAt ? <Badge tone="green">Stable</Badge> : null}
      {b.manifest.git.dirty ? <Badge tone="amber" title="Built from uncommitted changes">Uncommitted</Badge> : null}
      {b.customerTitle ? <Badge title="What customers see">Title: {b.customerTitle}</Badge> : null}
      {lacking.map((l) => (
        <Badge key={l.family} tone="amber" title={l.why}>
          Can't run on {l.labels.join(", ")}
        </Badge>
      ))}
    </div>
  )
}

type Filter = "all" | "live" | "stable" | "none"

export function RowActions({ b }: { b: Bundle }) {
  const c = useApp()
  const s = c.state!
  const { steps, extras } = bundleActions(s, b)
  const visible = steps.filter((a) => a.enabled).slice(0, 2)
  const rest = [...steps.filter((a) => !visible.includes(a)), ...extras]
  return (
    <div className="row-actions">
      {visible.map((a) => (
        <Btn key={a.id} small kind={a.id === "production" ? "primary" : "soft"} onClick={() => c.open(a.dialog)}>
          {a.label}
        </Btn>
      ))}
      <Menu items={rest.map((a) => ({ label: a.label, onClick: () => c.open(a.dialog), disabled: !a.enabled, why: a.why, danger: a.danger }))} />
    </div>
  )
}

export function Bundles() {
  const c = useApp()
  const s = c.state!
  const [filter, setFilter] = useState<Filter>("all")
  const [q, setQ] = useState("")
  const list = useMemo(() => {
    const term = q.trim().toLowerCase().replace(/^#/, "")
    return s.bundles.filter((b) => {
      if (filter === "live" && b.liveOn.length === 0) return false
      if (filter === "stable" && !b.stableAt) return false
      if (filter === "none" && b.everOn.length > 0) return false
      if (!term) return true
      return [String(b.serial), b.gitSubject, b.manifest.git.commit, b.builtBy, b.customerTitle ?? ""].some((t) => t.toLowerCase().includes(term))
    })
  }, [s.bundles, filter, q])
  return (
    <>
      <PageHead title="Bundles" sub="Every bundle uploaded for this app. New ones come from the CLI (see Store builds & families for the commands)." />
      <div className="toolbar">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            ["all", "All"],
            ["live", "Live"],
            ["stable", "Stable"],
            ["none", "Not on any channel"],
          ]}
        />
        <input className="search" type="search" placeholder="Search number, commit, subject, person" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search bundles" />
      </div>
      {s.bundles.length === 0 ? (
        <Empty title="No bundles yet">Build one with the CLI: bun run updates build, then bun run updates upload.</Empty>
      ) : list.length === 0 ? (
        <Empty title="No bundle matches">Change the filter or the search.</Empty>
      ) : (
        <div className="rows">
          {list.map((b) => (
            <div key={b.id} className="brow">
              <a className="brow-serial num" href={c.href(`/bundles/${b.serial}`)}>
                #{b.serial}
              </a>
              <div className="brow-main">
                <a className="brow-title" href={c.href(`/bundles/${b.serial}`)}>
                  {b.gitSubject || "No git subject"}
                </a>
                <div className="brow-meta">
                  <span className="code">{b.manifest.git.commit.slice(0, 7)}</span>
                  <span>{bytes(b.manifest.zip.size)}</span>
                  <span>
                    built by {b.builtBy}, <When at={b.builtAt} />
                  </span>
                </div>
                <BundleBadges s={s} b={b} />
              </div>
              <RowActions b={b} />
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ---- One bundle -------------------------------------------------------------------------------------------------------

interface TimelineItem {
  at: string
  text: string
  tone?: "green" | "red" | "blue"
}

function timeline(s: State, b: Bundle): TimelineItem[] {
  const out: TimelineItem[] = [{ at: b.builtAt, text: `Built and uploaded by ${b.builtBy}` }]
  for (const ch of s.channels) {
    const h = ch.history // newest first
    h.forEach((row, i) => {
      if (row.pointer.target !== b.id) return
      const reason = row.pointer.reason ? ` (${row.pointer.reason})` : ""
      out.push({ at: row.at, tone: row.kind === "rollback" ? "red" : "blue", text: `${kindWords(row.kind)} on ${ch.name} at ${row.pointer.rollout}% by ${row.publishedBy}${reason}` })
      const later = h[i - 1]
      if (later && later.pointer.target !== b.id) out.push({ at: later.at, text: `${ch.name} moved to ${targetLabel(later.pointer.target)}` })
    })
  }
  if (b.stableAt) out.push({ at: b.stableAt, tone: "green", text: `Marked stable by ${b.stableBy}${b.stableNote ? `: ${b.stableNote}` : ""}` })
  return out.sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime())
}

export function BundlePage({ serial }: { serial: number }) {
  const c = useApp()
  const s = c.state!
  const b = s.bundles.find((x) => x.serial === serial)
  const stg = useLoad(() => routes.stats(s.app.id, STAGING, 1), [s.app.id, c.rev])
  const prd = useLoad(() => routes.stats(s.app.id, PRODUCTION, 1), [s.app.id, c.rev])
  if (!b) {
    return (
      <>
        <PageHead title={`Bundle #${serial}`} back={{ href: c.href("/bundles"), label: "All bundles" }} />
        <Empty title={`No bundle #${serial}`}>It may have been deleted.</Empty>
      </>
    )
  }
  const m = b.manifest
  const onIt = (st: Stats | undefined) => (st ? st.phones.filter((p) => p.day === todayUtc() && p.running === b.id).reduce((n, p) => n + p.phones, 0) : 0)
  const lacking = cannotRun(s, b)
  return (
    <>
      <PageHead
        title={<>Bundle <span className="num">#{b.serial}</span></>}
        sub={b.gitSubject || "No git subject"}
        back={{ href: c.href("/bundles"), label: "All bundles" }}
        right={<RowActions b={b} />}
      />
      <BundleBadges s={s} b={b} />
      <div className="grid two mt">
        <Card title="Facts">
          <dl className="facts wide">
            <dt>Id</dt>
            <dd className="code">{b.id}</dd>
            <dt>Bundle SHA-256</dt>
            <dd className="code break">{m.bundleSha256}</dd>
            <dt>Zip SHA-256</dt>
            <dd className="code break">{m.zip.sha256}</dd>
            <dt>Zip size</dt>
            <dd>{bytes(m.zip.size)}</dd>
            <dt>Needs</dt>
            <dd className="chips-static">
              {requiresList(m.requires).map((r) => (
                <Badge key={r}>{r}</Badge>
              ))}
            </dd>
            <dt>Git</dt>
            <dd>
              <span className="code">{m.git.commit.slice(0, 7)}</span> {m.git.dirty ? <Badge tone="amber">uncommitted changes</Badge> : null}
              <div className="muted">{b.gitSubject}</div>
            </dd>
            <dt>Signed with key</dt>
            <dd className="code">{m.signature.keyId}</dd>
            <dt>Built</dt>
            <dd>
              {dateTime(b.builtAt)} by {b.builtBy}
            </dd>
            <dt>Stable</dt>
            <dd>{b.stableAt ? `${dateTime(b.stableAt)} by ${b.stableBy}${b.stableNote ? `: ${b.stableNote}` : ""}` : "Not marked"}</dd>
            <dt>Customer title</dt>
            <dd>{b.customerTitle ? `"${b.customerTitle}"` : <span className="muted">none (silent fix)</span>}</dd>
          </dl>
        </Card>
        <div className="stack">
          <Card title="Phones on it today">
            <div className="cc-stats">
              <div>
                <div className="stat-label">Staging</div>
                <div className="stat-value small num">{stg.loading && !stg.data ? "…" : onIt(stg.data)}</div>
              </div>
              <div>
                <div className="stat-label">Production</div>
                <div className="stat-value small num">{prd.loading && !prd.data ? "…" : onIt(prd.data)}</div>
              </div>
            </div>
          </Card>
          <Card title="Can app builds run it?">
            {s.families.length === 0 ? (
              <p className="muted">No app build family is known yet. The first phone check from a store build tells us.</p>
            ) : lacking.length === 0 ? (
              <Notice tone="green">All known app build families can run #{b.serial}.</Notice>
            ) : (
              <ul className="plain">
                {lacking.map((l) => (
                  <li key={l.family}>
                    <strong>{l.labels.join(", ")}</strong> cannot run it: {l.why}.
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      <Card title="Timeline">
        <ul className="timeline">
          {timeline(s, b).map((t, i) => (
            <li key={i} className={t.tone ?? ""}>
              <div>{t.text}</div>
              <div className="muted small" title={dateTime(t.at)}>
                {dateTime(t.at)} ({ago(t.at)})
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </>
  )
}

export function serialFromRoute(id: string | undefined): number | null {
  const n = Number(id)
  return Number.isInteger(n) && n > 0 ? n : null
}


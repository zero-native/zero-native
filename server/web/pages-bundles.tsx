// Overview, Bundles and the bundle page.
import { useMemo, useState } from "react"
import { type Bundle, routes, type Sizes, type State, type Stats, type StoreBuild } from "./api"
import { bundleActions, cannotRun, channelNow, type ChannelNow, keptStoreBuilds, nextHints, PRODUCTION, STAGING } from "./logic"
import { Badge, Btn, Card, Empty, ErrorBox, Menu, Notice, PageHead, Segmented, Skeleton, Stat, useApp, useLoad, When } from "./ui"
import { actionWords, ago, bytes, dateOnly, dateTime, daysLeft, kindWords, priorityWords, requiresGroups, serialOf, targetLabel } from "./util"

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
        <dd>{priorityWords(n.priority)}</dd>
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
  const stable = s.bundles.filter((b) => b.stableAt && !b.deleteAt).length
  const kept = s.bundles.filter((b) => !b.deleteAt).length
  const marked = s.bundles.length - kept
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
        <Stat label="Bundles" value={kept} sub={`${stable} stable${marked ? `, ${marked} marked for delete` : ""}`} />
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

/** [builtIn]: the store builds that carry this bundle as their built-in bundle (one bundle = one serial, so a bundle can be both). */
export function BundleBadges({ s, b, builtIn = [] }: { s: State; b: Bundle; builtIn?: StoreBuild[] }) {
  const lacking = cannotRun(s, b)
  return (
    <div className="badges">
      {b.deleteAt ? (
        <Badge tone="red" title={`Marked by ${b.deleteBy ?? "?"}: removed for good on ${dateOnly(b.deleteAt)}. Undo from the menu.`}>
          Deletes in {daysLeft(b.deleteAt)} {daysLeft(b.deleteAt) === 1 ? "day" : "days"}
        </Badge>
      ) : null}
      {b.liveOn.includes(STAGING) ? <Badge tone="blue">Live on staging</Badge> : null}
      {b.liveOn.includes(PRODUCTION) ? <Badge tone="brand">Live on production</Badge> : null}
      {b.everOn.includes(PRODUCTION) && !b.liveOn.includes(PRODUCTION) ? <Badge title="Production served it before">Was on production</Badge> : null}
      {b.stableAt ? <Badge tone="green">Stable</Badge> : null}
      {b.manifest.git.dirty ? <Badge tone="amber" title="Built from uncommitted changes">Uncommitted</Badge> : null}
      {b.customerTitle ? <Badge title="What customers see">Title: {b.customerTitle}</Badge> : null}
      {builtIn.length ? <Badge title="Also inside a store build: phones on it already have this bundle">In the app</Badge> : null}
      {builtIn.some((x) => x.liveAt) ? <Badge tone="green" title="Built into a store build marked live on the store: it can't be deleted">Live on the store</Badge> : null}
      {builtIn.map((sb) => (
        <Badge key={`${sb.os}-${sb.channel}-${sb.versionCode}`} tone="blue" title={`${sb.os === "ios" ? "iOS" : "Android"} ${sb.versionName} (${sb.versionCode}), ${sb.channel}`}>
          {sb.label}
        </Badge>
      ))}
      {lacking.map((l) => (
        <Badge key={l.family} tone="amber" title={l.why}>
          Can't run on {l.labels.join(", ")}
        </Badge>
      ))}
    </div>
  )
}

type Filter = "all" | "live" | "stable" | "none" | "builtin" | "deleting"

/**
 * A store build's built-in bundle, as a row of the Bundles list (Pavan, 2026-11-09: every bundle number is listed, so a
 * patch "from #12 (built-in)" points at a row). It isn't an OTA bundle: no channel can serve it and it has no actions;
 * the row links to Store builds. Its zip on the server (if any) is only the base for patches.
 */
function BuiltInRow({ list }: { list: StoreBuild[] }) {
  const c = useApp()
  const to = c.href("/builds")
  // Store builds with the same built-in serial carry the same bundle: one row, the newest build first.
  const sb = list[0]!
  return (
    <div className="brow builtin">
      <a className="brow-serial num" href={to}>
        #{sb.builtinSerial}
      </a>
      <div className="brow-main">
        <a className="brow-title" href={to}>
          Built into {list.map((x) => x.label).join(", ")}
        </a>
        <div className="brow-meta">
          <span className="code">{sb.git.commit.slice(0, 7)}</span>
          <span>
            {sb.os === "ios" ? "iOS" : "Android"} {sb.versionName} ({sb.versionCode})
          </span>
          <span>
            built by {sb.builtBy}, <When at={sb.builtAt} />
          </span>
        </div>
        <div className="badges">
          <Badge title="Inside the store build: no channel serves it">In the app</Badge>
          {list.some((x) => x.liveAt) ? (
            <Badge tone="green" title="A store build with it is marked live on the store: it can't be deleted">
              Live on {list.find((x) => x.liveAt)!.os === "ios" ? "App Store" : "Play"}
            </Badge>
          ) : null}
          {[...new Set(list.map((x) => x.channel))].map((ch) => (
            <ChannelTag key={ch} name={ch} />
          ))}
          {sb.baseSize !== null ? (
            <Badge tone="green" title="Its zip is on the server: phones on this build get patches">
              Base for patches, {bytes(sb.baseSize)}
            </Badge>
          ) : (
            <Badge tone="amber" title="No zip on the server: phones on this build get full zips until their first OTA (updates base --serial N)">
              No base: full zips
            </Badge>
          )}
          {sb.git.dirty ? <Badge tone="amber" title="Built from uncommitted changes">Uncommitted</Badge> : null}
        </div>
      </div>
      <div className="row-actions" />
    </div>
  )
}

type Row = { serial: number; key: string; ota?: Bundle; builtIn: StoreBuild[] }

export function RowActions({ b }: { b: Bundle }) {
  const c = useApp()
  const s = c.state!
  const { steps, extras } = bundleActions(s, b)
  // Marked for delete: the one thing to offer is keeping it (publishing waits for that)
  const visible = b.deleteAt ? extras.filter((a) => a.id === "undelete") : steps.filter((a) => a.enabled).slice(0, 2)
  const rest = [...steps.filter((a) => !visible.includes(a)), ...extras.filter((a) => !visible.includes(a))]
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

/** "3 patches, from 41.2 KB": what phones on older bundles download instead of the full zip. */
function PatchesText({ b }: { b: Bundle }) {
  if (b.patches.length === 0) return <span title="Phones on older bundles download the full zip">no patches</span>
  const small = Math.min(...b.patches.map((p) => p.size))
  const from = b.patches.map((p) => `#${serialOf(p.fromId)} ${bytes(p.size)}`).join(", ")
  return (
    <span title={`Patches from: ${from}`}>
      {b.patches.length} {b.patches.length === 1 ? "patch" : "patches"}, from {bytes(small)}
    </span>
  )
}

export function Bundles() {
  const c = useApp()
  const s = c.state!
  const [filter, setFilter] = useState<Filter>("all")
  const [q, setQ] = useState("")
  const list = useMemo(() => {
    const term = q.trim().toLowerCase().replace(/^#/, "")
    const has = (...texts: string[]) => !term || texts.some((t) => t.toLowerCase().includes(term))
    // One bundle = one serial: store builds are grouped by the serial of their built-in bundle
    const carriers = new Map<number, StoreBuild[]>()
    // Store builds marked for delete are listed on Store builds only
    for (const sb of keptStoreBuilds(s)) carriers.set(sb.builtinSerial, [...(carriers.get(sb.builtinSerial) ?? []), sb])
    const builtText = (list: StoreBuild[]) => list.flatMap((sb) => [sb.label, sb.git.commit, sb.builtBy, sb.versionName, String(sb.versionCode), "built-in", "in the app"])
    // A bundle that is also built into a store build is ONE row (the bundle's), with the "In the app" chip
    const ota: Row[] = s.bundles
      .filter((b) => {
        // Bundles marked for delete are hidden, except under their own filter (to undo one)
        if ((filter === "deleting") !== !!b.deleteAt) return false
        const inApp = carriers.get(b.serial) ?? []
        if (filter === "builtin") return inApp.length > 0 && has(String(b.serial), b.gitSubject, b.manifest.git.commit, b.builtBy, b.customerTitle ?? "", ...builtText(inApp))
        if (filter === "live" && b.liveOn.length === 0) return false
        if (filter === "stable" && !b.stableAt) return false
        if (filter === "none" && b.everOn.length > 0) return false
        return has(String(b.serial), b.gitSubject, b.manifest.git.commit, b.builtBy, b.customerTitle ?? "", ...builtText(inApp))
      })
      .map((b) => ({ serial: b.serial, key: b.id, ota: b, builtIn: carriers.get(b.serial) ?? [] }))
    // A built-in bundle nobody released has no channel: it shows under All and its own filter only
    const released = new Set(s.bundles.map((b) => b.serial))
    const builtIn: Row[] = filter !== "all" && filter !== "builtin" ? [] : [...carriers.entries()]
      .filter(([serial, list]) => !released.has(serial) && has(String(serial), ...builtText(list)))
      .map(([serial, list]) => ({ serial, key: `built-in-${serial}`, builtIn: list }))
    return [...ota, ...builtIn].sort((x, y) => y.serial - x.serial)
  }, [s.bundles, s.storeBuilds, filter, q])
  const none = s.bundles.length === 0 && s.storeBuilds.length === 0
  const marked = s.bundles.filter((b) => b.deleteAt).length
  return (
    <>
      <PageHead title="Bundles" sub="Every bundle of this app: the ones uploaded for channels, and the ones built into store builds. New ones come from the CLI (see Store builds & families for the commands)." />
      <div className="toolbar">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            ["all", "All"],
            ["live", "Live"],
            ["stable", "Stable"],
            ["none", "Not on any channel"],
            ["builtin", "In an app"],
            ...(marked || filter === "deleting" ? [["deleting", `Marked for delete (${marked})`] as [Filter, string]] : []),
          ]}
        />
        <input className="search" type="search" placeholder="Search number, commit, subject, person" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search bundles" />
      </div>
      {none ? (
        <Empty title="No bundles yet">Build one with the CLI: bun run updates build, then bun run updates upload.</Empty>
      ) : list.length === 0 ? (
        filter === "deleting" ? <Empty title="Nothing is marked for delete" /> : <Empty title="No bundle matches">Change the filter or the search.</Empty>
      ) : (
        <div className="rows">
          {list.map(({ key, ota: b, builtIn }) => !b ? <BuiltInRow key={key} list={builtIn} /> : (
            <div key={key} className="brow">
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
                  <PatchesText b={b} />
                  <span>
                    built by {b.builtBy}, <When at={b.builtAt} />
                  </span>
                </div>
                <BundleBadges s={s} b={b} builtIn={builtIn} />
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
      <BundleBadges s={s} b={b} builtIn={s.storeBuilds.filter((sb) => sb.builtinSerial === b.serial)} />
      {b.deleteAt ? (
        <div className="mt">
          <Notice tone="red">
            Marked for delete by {b.deleteBy ?? "?"}. It goes for good on <strong>{dateOnly(b.deleteAt)}</strong>, with its patches and source map. Until then it can't be published.{" "}
            <a href="#" onClick={(e) => { e.preventDefault(); c.open({ t: "delete", serial: b.serial, on: false }) }}>Keep it</a>
          </Notice>
        </div>
      ) : null}
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
            <dd className="needs">
              {requiresGroups(m.requires, m.moduleFrom).map((g) => (
                <div key={g.title} className="needs-group">
                  <div className="needs-title muted">{g.title}</div>
                  <div className="chips-static">
                    {g.items.map((x) => (
                      <Badge key={x.label} title={x.from}>
                        {x.label}
                      </Badge>
                    ))}
                  </div>
                </div>
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
      <Card title="Patches">
        {b.patches.length === 0 ? (
          <p className="muted">No patches for #{b.serial}. Phones on an older bundle download the full zip ({bytes(m.zip.size)}). Patches are made after the upload, from the newest earlier bundles and store builds that have a base.</p>
        ) : (
          <>
            <p className="muted small">A phone on one of these bundles downloads the patch instead of the full zip ({bytes(m.zip.size)}).</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>From</th>
                    <th>Size</th>
                    <th>Of the full zip</th>
                  </tr>
                </thead>
                <tbody>
                  {b.patches.map((p) => {
                    const from = serialOf(p.fromId)
                    const bundle = s.bundles.some((x) => x.serial === from)
                    return (
                      <tr key={p.fromSha256}>
                        <td className="num">{bundle ? <a href={c.href(`/bundles/${from}`)}>#{from}</a> : <a href={c.href("/builds")}>built-in #{from}</a>}</td>
                        <td className="num">{(p.size / 1024).toFixed(1)} KB</td>
                        <td className="num">{((p.size / m.zip.size) * 100).toFixed(1)}%</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
      <SizeCard serial={b.serial} />
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

// ---- Size by file (from the source map) -------------------------------------------------------------------------------

function Bars({ parts, total, before }: { parts: { name: string; bytes: number }[]; total: number; before?: Map<string, number> }) {
  const top = parts[0]?.bytes ?? 1
  return (
    <ul className="bars">
      {parts.map((p) => {
        const was = before?.get(p.name)
        const change = was === undefined ? p.bytes : p.bytes - was
        return (
          <li key={p.name}>
            <div className="bar-name" title={p.name}>
              {p.name}
            </div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${Math.max(1, (p.bytes / top) * 100)}%` }} />
            </div>
            <div className="bar-num num">{bytes(p.bytes)}</div>
            <div className="bar-pct num muted">{((p.bytes / total) * 100).toFixed(1)}%</div>
            {before ? (
              <div className={`bar-change num ${change >= 1024 ? "red" : change <= -1024 ? "green" : "muted"}`}>
                {was === undefined ? "new" : Math.abs(change) < 1024 ? "same" : `${change > 0 ? "+" : "−"}${bytes(Math.abs(change))}`}
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/** Biggest changes by folder against the bundle before (new folders count all their size, gone ones a minus). */
function changes(now: Sizes, was: Sizes) {
  const a = new Map(now.folders.map((f) => [f.name, f.bytes]))
  const b = new Map(was.folders.map((f) => [f.name, f.bytes]))
  const names = new Set([...a.keys(), ...b.keys()])
  return [...names]
    .map((name) => ({ name, change: (a.get(name) ?? 0) - (b.get(name) ?? 0) }))
    .filter((x) => Math.abs(x.change) >= 1024)
    .sort((x, y) => Math.abs(y.change) - Math.abs(x.change))
    .slice(0, 8)
}

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${bytes(Math.abs(n))}`

function SizeCard({ serial }: { serial: number }) {
  const c = useApp()
  const r = useLoad(() => routes.bundleSize(c.appId, serial), [c.appId, serial])
  const [view, setView] = useState<"folders" | "files">("folders")
  const sz = r.data?.sizes
  const before = r.data?.before ?? null
  const total = sz ? sz.mapped + sz.unmapped : 0
  const totalBefore = before ? before.sizes.mapped + before.sizes.unmapped : 0
  const moved = sz && before ? changes(sz, before.sizes) : []
  const was = before ? new Map((view === "folders" ? before.sizes.folders : before.sizes.files).map((p) => [p.name, p.bytes])) : undefined
  const zip = c.state!.bundles.find((x) => x.serial === serial)?.manifest.zip.size ?? 0
  return (
    <Card
      title="Size by file"
      right={sz ? <Segmented<"folders" | "files"> value={view} onChange={setView} options={[["folders", "Packages & folders"], ["files", "Files"]]} /> : null}
    >
      {r.loading && !r.data ? (
        <Skeleton rows={4} />
      ) : r.error ? (
        <ErrorBox error={r.error} retry={r.reload} />
      ) : !sz ? (
        <p className="muted">
          No source map on the server for #{serial}. The CLI uploads one with each new bundle. For older bundles, run <span className="code">bun run updates maps</span> in the app folder.
        </p>
      ) : (
        <>
          <div className="grid stats tight">
            <Stat label="JavaScript, about" value={bytes(total)} sub={`${sz.fileCount} source files`} />
            {before ? <Stat label={`Change since #${before.serial}`} value={signed(total - totalBefore)} tone={total - totalBefore > 10 * 1024 ? "red" : undefined} sub="the JavaScript, before Hermes" /> : null}
            {sz.unmapped > 0 ? <Stat label="Not from a file" value={bytes(sz.unmapped)} sub="code the bundler added" /> : null}
          </div>
          {moved.length ? (
            <p className="muted small">
              Biggest changes since #{before!.serial}: {moved.map((m) => `${m.name} ${signed(m.change)}`).join(", ")}
            </p>
          ) : null}
          <Bars parts={view === "folders" ? sz.folders : sz.files} total={total} before={was} />
          <p className="muted small mt">
            The JavaScript before Hermes compiles it, read from the source map: about 10% under the real size, the same for every file. Good for "what is big" and "what grew", not for exact bytes. Phones download a zip of {bytes(zip)}.
          </p>
        </>
      )}
    </Card>
  )
}

export function serialFromRoute(id: string | undefined): number | null {
  const n = Number(id)
  return Number.isInteger(n) && n > 0 ? n : null
}


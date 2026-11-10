// Phones, Activity, Environment.
import { useEffect, useMemo, useState } from "react"
import { type ActivityRow, routes, type Stats } from "./api"
import { orderedChannels } from "./logic"
import { errorScreens, phonesToday, todayUtc, ChannelTag } from "./pages-bundles"
import { keyIdOfPublic } from "./sign"
import { Badge, Btn, Card, CopyBlock, Empty, ErrorBox, PageHead, Segmented, Skeleton, Stat, useApp, useLoad, When } from "./ui"
import { ACTION_FILTERS, actionWords, dateTime, dayLabel, eventWords, num, runningLabel, runningShort, SERIOUS } from "./util"

// ---- Phones -----------------------------------------------------------------------------------------------------------

const PALETTE = ["#5B3DF5", "#0F8FD9", "#14A3A3", "#F2A20C", "#D6409F", "#8E7CF8", "#6BB8F0", "#4B5563"]
const BUILT_IN_COLOR = "#C3CAD3"

function lastDays(n: number): string[] {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10))
  return out
}

function PhoneChart({ st, days, colorOf }: { st: Stats; days: number; colorOf: (r: string) => string }) {
  const list = lastDays(days)
  const W = 720
  const H = 200
  const pad = { l: 34, r: 6, t: 8, b: 22 }
  const byDay = new Map<string, { running: string; phones: number }[]>()
  for (const p of st.phones) byDay.set(p.day, [...(byDay.get(p.day) ?? []), p])
  const totals = list.map((d) => (byDay.get(d) ?? []).reduce((n, p) => n + p.phones, 0))
  const max = Math.max(1, ...totals)
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const slot = iw / list.length
  const bw = Math.min(48, slot * 0.7)
  const every = list.length > 20 ? 5 : list.length > 8 ? 2 : 1
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Phones per day, split by the bundle they run">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={pad.l} x2={W - pad.r} y1={pad.t + ih * (1 - f)} y2={pad.t + ih * (1 - f)} className="grid-line" />
          <text x={pad.l - 6} y={pad.t + ih * (1 - f) + 4} textAnchor="end" className="axis">
            {Math.round(max * f)}
          </text>
        </g>
      ))}
      {list.map((d, i) => {
        const x = pad.l + slot * i + (slot - bw) / 2
        let y = pad.t + ih
        const segs = [...(byDay.get(d) ?? [])].sort((a, b) => a.running.localeCompare(b.running))
        return (
          <g key={d}>
            {segs.map((p) => {
              const h = (p.phones / max) * ih
              y -= h
              return (
                <rect key={p.running} x={x} y={y} width={bw} height={h} fill={colorOf(p.running)} rx={2}>
                  <title>{`${dayLabel(d)}: ${p.phones} on ${runningLabel(p.running)}`}</title>
                </rect>
              )
            })}
            {i % every === 0 || i === list.length - 1 ? (
              <text x={x + bw / 2} y={H - 6} textAnchor="middle" className="axis">
                {dayLabel(d)}
              </text>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}

export function Phones() {
  const c = useApp()
  const s = c.state!
  const [channel, setChannel] = useState("production")
  const [days, setDays] = useState(7)
  const st = useLoad(() => routes.stats(s.app.id, channel, days), [s.app.id, channel, days, c.rev])
  const data = st.data
  const view = useMemo(() => {
    if (!data) return null
    const running = [...new Set(data.phones.map((p) => p.running))].sort((a, b) => (a.startsWith("built-in") ? 1 : 0) - (b.startsWith("built-in") ? 1 : 0) || b.localeCompare(a, undefined, { numeric: true }))
    const colorOf = (r: string) => (r.startsWith("built-in") ? BUILT_IN_COLOR : (PALETTE[running.filter((x) => !x.startsWith("built-in")).indexOf(r) % PALETTE.length] ?? PALETTE[0]!))
    const t = todayUtc()
    const bundles = new Map<string, { today: number; days: number; events: Map<string, number> }>()
    const get = (b: string) => {
      let v = bundles.get(b)
      if (!v) bundles.set(b, (v = { today: 0, days: 0, events: new Map() }))
      return v
    }
    for (const p of data.phones) {
      const v = get(p.running)
      v.days += p.phones
      if (p.day === t) v.today += p.phones
    }
    for (const e of data.events) {
      const v = get(e.bundle)
      v.events.set(e.kind, (v.events.get(e.kind) ?? 0) + e.count)
    }
    const rows = [...bundles.entries()].sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
    return { running, colorOf, rows }
  }, [data])
  return (
    <>
      <PageHead title="Phones" sub="Counts come from phone checks. A phone counts once per day. Kept for 35 days." />
      <div className="toolbar">
        <Segmented<string> value={channel} onChange={setChannel} options={orderedChannels(s).map((x) => [x.name, x.name] as [string, string])} />
        <Segmented<number>
          value={days}
          onChange={setDays}
          options={[
            [1, "1 day"],
            [7, "7 days"],
            [35, "35 days"],
          ]}
        />
      </div>
      {st.error ? <ErrorBox error={st.error} retry={st.reload} /> : null}
      {!data && st.loading ? <Skeleton rows={5} /> : null}
      {data && view ? (
        <>
          <div className="grid stats">
            <Stat label="Phones today" value={num(phonesToday(data))} />
            <Stat label="Bundles seen" value={view.running.length} sub={`in ${days === 1 ? "1 day" : `${days} days`}`} />
            <Stat label="Error screens" value={num(errorScreens(data))} tone={errorScreens(data) > 0 ? "red" : undefined} sub={`in ${days === 1 ? "1 day" : `${days} days`}`} />
          </div>
          {data.phones.length === 0 && data.events.length === 0 ? (
            <Empty title="No phone checks in this time">Phones show up here after they check for updates on {channel}.</Empty>
          ) : (
            <>
              <Card title="Phones per day" right={<span className="muted small">by the bundle each phone runs</span>}>
                <PhoneChart st={data} days={days} colorOf={view.colorOf} />
                <div className="legend">
                  {view.running.map((r) => (
                    <span key={r}>
                      <i style={{ background: view.colorOf(r) }} /> {runningShort(r)}
                    </span>
                  ))}
                </div>
              </Card>
              <Card title="By bundle">
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Bundle</th>
                        <th>Phones today</th>
                        <th>Phone-days</th>
                        <th>What phones reported</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.rows.map(([b, v]) => (
                        <tr key={b}>
                          <td className="num strong">
                            <i className="dot" style={{ background: view.colorOf(b) }} />
                            {b.startsWith("built-in") ? runningLabel(b) : <a href={c.href(`/bundles/${runningShort(b).slice(1)}`)}>{runningShort(b)}</a>}
                          </td>
                          <td className="num">{v.today}</td>
                          <td className="num">{v.days}</td>
                          <td>
                            <div className="chips-static">
                              {[...v.events.entries()]
                                .sort(([a], [b2]) => Number(SERIOUS.includes(b2)) - Number(SERIOUS.includes(a)) || a.localeCompare(b2))
                                .map(([k, n]) => (
                                  <Badge key={k} tone={SERIOUS.includes(k) ? "red" : "grey"}>
                                    {eventWords(k)} {n}
                                  </Badge>
                                ))}
                              {v.events.size === 0 ? <span className="muted">nothing</span> : null}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted small mt">Phone-days: a phone that checked on 3 days counts 3 times.</p>
              </Card>
              <Card title="Recent errors">
                {data.errors.length === 0 ? (
                  <Empty title="No errors in this time" />
                ) : (
                  <ul className="errors">
                    {data.errors.map((e, i) => (
                      <li key={`${e.at}-${i}`}>
                        <div className="err-head">
                          <Badge tone="red">{eventWords(e.kind)}</Badge>
                          <span className="num strong">{e.bundle.startsWith("built-in") ? runningLabel(e.bundle) : runningShort(e.bundle)}</span>
                          {e.detail ? <span className="muted">{e.detail}</span> : null}
                          <span className="muted small push" title={dateTime(e.at)}>
                            <When at={e.at} />
                          </span>
                        </div>
                        {e.decoded ? <CopyBlock text={e.decoded} /> : e.stack ? <CopyBlock text={e.stack} /> : <p className="muted small">No stack was sent.</p>}
                        {e.stack && !e.decoded ? <p className="muted small">Shown as the phone sent it: the server has no source map for this bundle (bun run updates maps uploads them).</p> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </>
          )}
        </>
      ) : null}
    </>
  )
}

// ---- Activity ---------------------------------------------------------------------------------------------------------

const PAGE = 50

export function Activity() {
  const c = useApp()
  const [rows, setRows] = useState<ActivityRow[] | null>(null)
  const [more, setMore] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [action, setAction] = useState("")
  const [person, setPerson] = useState("")
  const load = async (append: boolean) => {
    setBusy(true)
    setError("")
    try {
      const before = append && rows?.length ? rows[rows.length - 1]!.id : undefined
      const got = await routes.activity(c.appId, before, PAGE)
      setRows(append ? [...(rows ?? []), ...got] : got)
      setMore(got.length === PAGE)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  // biome-ignore lint: reload when the app or the data changes
  useEffect(() => {
    void load(false)
  }, [c.appId, c.rev])
  const people = useMemo(() => [...new Set((rows ?? []).map((r) => r.by))].sort(), [rows])
  const shown = (rows ?? []).filter((r) => (!action || r.action === action) && (!person || r.by === person))
  return (
    <>
      <PageHead title="Activity" sub="Every action in the dashboard and the CLI, newest first." />
      <div className="toolbar">
        <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action">
          <option value="">All actions</option>
          {ACTION_FILTERS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Filter by person">
          <option value="">Everyone</option>
          {people.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {action || person ? <span className="muted small">Filters apply to the rows loaded so far.</span> : null}
      </div>
      {error ? <ErrorBox error={error} retry={() => void load(false)} /> : null}
      {rows === null ? (
        <Skeleton rows={6} />
      ) : shown.length === 0 ? (
        <Empty title={rows.length === 0 ? "Nothing has happened yet" : "No rows match"}>{rows.length === 0 ? "" : more ? "Show more to look further back." : "Change the filters."}</Empty>
      ) : (
        <Card>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const w = actionWords(r)
                  return (
                    <tr key={r.id}>
                      <td className="nowrap" title={dateTime(r.at)}>
                        <When at={r.at} />
                      </td>
                      <td>{r.by}</td>
                      <td className="strong">{w.title}</td>
                      <td className="muted">{w.detail}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {more ? (
            <div className="center mt">
              <Btn busy={busy} onClick={() => void load(true)}>
                Show more
              </Btn>
            </div>
          ) : null}
        </Card>
      )}
    </>
  )
}

// ---- Environment ------------------------------------------------------------------------------------------------------

export function Environment() {
  const c = useApp()
  const s = c.state!
  const env = useLoad(() => routes.env(), [c.rev])
  const [ids, setIds] = useState<string[]>([])
  useEffect(() => {
    let live = true
    void Promise.all(s.app.publicKeys.map(keyIdOfPublic)).then((x) => live && setIds(x))
    return () => {
      live = false
    }
  }, [s.app.publicKeys])
  const idx = c.key ? s.app.publicKeys.indexOf(c.key.publicKey) : -1
  const android = s.app.store.android?.packages ?? {}
  const ios = s.app.store.ios
  return (
    <>
      <PageHead title="Environment" sub="The server, the keys phones trust, and the app's store facts." />
      <div className="grid two">
        <Card title="Server">
          {env.error ? (
            <ErrorBox error={env.error} retry={env.reload} />
          ) : !env.data ? (
            <Skeleton rows={4} />
          ) : (
            <dl className="facts wide">
              <dt>Database</dt>
              <dd>{env.data.database}</dd>
              <dt>Files</dt>
              <dd className="code break">{env.data.storage}</dd>
              <dt>Started</dt>
              <dd>
                {dateTime(env.data.started)} (<When at={env.data.started} />)
              </dd>
              <dt>Version</dt>
              <dd>{env.data.version}</dd>
              <dt>Server time</dt>
              <dd>{dateTime(env.data.now)}</dd>
            </dl>
          )}
        </Card>
        <Card title="Signing key in this tab" right={<Btn small onClick={() => c.open({ t: "key" })}>{c.key ? "Change" : "Load key"}</Btn>}>
          {c.key ? (
            <>
              <dl className="facts wide">
                <dt>Key id</dt>
                <dd className="code">{c.key.keyId}</dd>
                <dt>Matches</dt>
                <dd>{idx >= 0 ? <Badge tone="green">{idx === 0 ? "main key" : "backup key"} of this app</Badge> : <Badge tone="red">none of this app's keys</Badge>}</dd>
              </dl>
              {idx < 0 ? <p className="muted small mt">The dashboard will not sign with this key: phones would refuse it.</p> : null}
            </>
          ) : (
            <p className="muted">No key loaded. Load it when you publish, roll back, change rollout or use the kill switch.</p>
          )}
        </Card>
      </div>
      <Card title="Public keys of this app" right={<span className="muted small">Phones trust signatures from these keys</span>}>
        {s.app.publicKeys.length === 0 ? (
          <Empty title="No public keys">Add one with the CLI before anyone can upload or publish.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Key id</th>
                  <th>Public key</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {s.app.publicKeys.map((k, i) => (
                  <tr key={k}>
                    <td>{i === 0 ? "Main" : i === 1 ? "Backup" : `Extra ${i - 1}`}</td>
                    <td className="code">{ids[i] ?? "…"}</td>
                    <td className="code break small">{k.slice(0, 40)}…</td>
                    <td>{c.key && c.key.publicKey === k ? <Badge tone="green">loaded</Badge> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Store facts">
        <dl className="facts wide">
          <dt>Android packages</dt>
          <dd>
            {Object.keys(android).length ? (
              <div className="chips-static">
                {Object.entries(android).map(([pkg, ch]) => (
                  <span key={pkg} className="pkg">
                    <span className="code">{pkg}</span> <ChannelTag name={ch} />
                  </span>
                ))}
              </div>
            ) : (
              <span className="muted">none set</span>
            )}
          </dd>
          <dt>iOS bundle ids</dt>
          <dd>
            {ios?.packages && Object.keys(ios.packages).length ? (
              <div className="chips-static">
                {Object.entries(ios.packages).map(([pkg, ch]) => (
                  <span key={pkg} className="pkg">
                    <span className="code">{pkg}</span> <ChannelTag name={ch} />
                  </span>
                ))}
              </div>
            ) : (
              <span className="muted">none set</span>
            )}
          </dd>
          <dt>App Store id</dt>
          <dd>{ios?.appStoreId ? <span className="code">{ios.appStoreId}</span> : <span className="muted">none set</span>}</dd>
        </dl>
      </Card>
    </>
  )
}

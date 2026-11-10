// Channels, Store updates, Store builds & families.
import { useState } from "react"
import { type Os, type Rule, routes, type State, type StoreAnswer, type StoreBuild } from "./api"
import { channelNow, needsColours, orderedChannels, PRODUCTION, sameNeeds } from "./logic"
import { ChannelTag, servesText } from "./pages-bundles"
import { Badge, Btn, Card, CopyBlock, Empty, NeedsTag, needsVar, Notice, PageHead, Segmented, Stat, useApp, When } from "./ui"
import { bytes, capabilityList, criticalWords, dateOnly, dateTime, daysLeft, kindWords, priorityWords, showVersion, targetLabel, versionNumber } from "./util"

// ---- Channels ---------------------------------------------------------------------------------------------------------

export function Channels() {
  const c = useApp()
  const s = c.state!
  return (
    <>
      <PageHead title="Channels" sub="What phones get on each channel, and every change made to it." />
      {orderedChannels(s).map((ch) => {
        const n = channelNow(s, ch.name)
        return (
          <div key={ch.name} className="channel-block">
            <div className="channel-grid">
              <Card className={`channel-card ${ch.name}`}>
                <div className="cc-top">
                  <ChannelTag name={ch.name} />
                  {n.killed ? <Badge tone="red">Kill switch ON</Badge> : null}
                </div>
                <h3 className="cc-title">Phones get now</h3>
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
                  <dd>{n.at ? <>{kindWords(n.kind ?? "")}, <When at={n.at} /> by {n.by}</> : "never"}</dd>
                  {n.reason ? (
                    <>
                      <dt>Reason</dt>
                      <dd>{n.reason}</dd>
                    </>
                  ) : null}
                </dl>
                <div className="btn-row">
                  <Btn disabled={n.killed || n.empty} title={n.killed ? "Killed: publish a bundle first" : n.empty ? "Nothing published yet" : undefined} onClick={() => c.open({ t: "change", mode: "rollout", channel: ch.name })}>
                    Change rollout
                  </Btn>
                  <Btn kind="danger" disabled={n.killed || n.empty} title={n.killed ? "Already killed" : n.empty ? "Nothing to kill" : undefined} onClick={() => c.open({ t: "change", mode: "kill", channel: ch.name })}>
                    Kill switch
                  </Btn>
                  <Btn kind="ghost" onClick={() => c.go("/bundles")}>
                    Publish another
                  </Btn>
                </div>
                {n.killed ? <p className="muted small mt">To end a kill switch, publish a bundle again.</p> : null}
              </Card>
              <Card title="History">
                {ch.history.length === 0 ? (
                  <Empty title="No changes yet" />
                ) : (
                  <div className="table-wrap tall">
                    <table>
                      <thead>
                        <tr>
                          <th>Seq</th>
                          <th>What</th>
                          <th>Bundle</th>
                          <th>Rollout</th>
                          <th>Priority</th>
                          <th>Reason</th>
                          <th>By</th>
                          <th>When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ch.history.map((h) => (
                          <tr key={h.pointer.seq}>
                            <td className="num">{h.pointer.seq}</td>
                            <td>
                              <Badge tone={h.kind === "kill" ? "red" : h.kind === "rollback" ? "amber" : "grey"}>{kindWords(h.kind)}</Badge>
                            </td>
                            <td className="num">{h.pointer.target === "BUILT_IN" ? targetLabel(h.pointer.target) : <a href={c.href(`/bundles/${targetLabel(h.pointer.target).slice(1)}`)}>{targetLabel(h.pointer.target)}</a>}</td>
                            <td className="num">{h.pointer.rollout}%</td>
                            <td>{priorityWords(h.pointer.priority)}</td>
                            <td>{h.pointer.reason ?? ""}</td>
                            <td>{h.publishedBy}</td>
                            <td title={dateTime(h.at)}>
                              <When at={h.at} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          </div>
        )
      })}
    </>
  )
}

// ---- Store updates ----------------------------------------------------------------------------------------------------

function thresholds(rules: Rule[]) {
  let optional: Rule | null = null
  let forced: Rule | null = null
  for (const r of rules) {
    if (r.critical >= 1 && (!optional || r.version > optional.version)) optional = r
    if (r.critical === 2 && (!forced || r.version > forced.version)) forced = r
  }
  return { optional, forced }
}

function Thresholds({ os, rules, label }: { os: Os; rules: Rule[]; label: string }) {
  const { optional, forced } = thresholds(rules)
  return (
    <Card title={label}>
      <div className="grid stats tight">
        <Stat label="Asked to update below" value={optional ? showVersion(os, optional.version) : "none"} sub="Optional: highest rule that is Optional or Forced" />
        <Stat label="Must update below" value={forced ? showVersion(os, forced.version) : "none"} tone={forced ? "red" : undefined} sub="Forced: highest Forced rule" />
      </div>
    </Card>
  )
}

function Checker({ os, channel }: { os: Os; channel: string }) {
  const c = useApp()
  const [v, setV] = useState("")
  const [ans, setAns] = useState<{ update: StoreAnswer | null; version: string } | null>(null)
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const n = versionNumber(os, v)
  const check = async () => {
    setBusy(true)
    setErr("")
    try {
      setAns({ ...(await routes.storeCheck(c.appId, channel, os, v.trim())), version: v.trim() })
    } catch (e) {
      setAns(null)
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Phone checker" right={<span className="muted small">What would a phone on {channel} with this version be told?</span>}>
      <form
        className="checker"
        onSubmit={(e) => {
          e.preventDefault()
          if (n !== null) void check()
        }}
      >
        <input value={v} onChange={(e) => { setV(e.target.value); setAns(null) }} inputMode={os === "ios" ? "text" : "numeric"} placeholder={os === "ios" ? "Phone's app version, like 1.5.0" : "Phone's versionCode, like 140"} aria-label="Phone version" />
        <Btn type="submit" kind="primary" disabled={n === null} busy={busy}>
          Check
        </Btn>
      </form>
      {v && n === null ? <p className="hint">{os === "ios" ? "Use a version like 1.6.2." : "Use a whole number."}</p> : null}
      {err ? <Notice tone="red">{err}</Notice> : null}
      {ans ? (
        ans.update ? (
          <Notice tone={ans.update.critical === 2 ? "red" : "amber"}>
            <strong>{ans.update.critical === 2 ? "Must update" : "Asked to update"}</strong> to {ans.update.version}.
            {ans.update.title ? <div>Title: {ans.update.title}</div> : null}
            {ans.update.message ? <div>Message: {ans.update.message}</div> : null}
          </Notice>
        ) : (
          <Notice tone="green">Version {ans.version} is fine. It is not asked to update.</Notice>
        )
      ) : null}
    </Card>
  )
}

export function StoreUpdates() {
  const c = useApp()
  const s = c.state!
  const [os, setOs] = useState<Os>("android")
  // Rules are per channel: a rule only reaches the phones of its own channel.
  const channelNames = orderedChannels(s).map((x) => x.name)
  const [picked, setChannel] = useState(PRODUCTION)
  const channel = channelNames.includes(picked) ? picked : (channelNames[0] ?? PRODUCTION)
  const rules = s.rules[os].filter((r) => r.channel === channel)
  const customers = thresholds(rules.filter((r) => !r.isTest))
  const noCustomerRule = rules.length > 0 && !customers.optional
  return (
    <>
      <PageHead
        title="Store updates"
        sub="Ask phones to update from Play or the App Store. The app shows its own update screen."
        right={
          <Btn kind="primary" onClick={() => c.open({ t: "rule", os, channel })}>
            Add a rule
          </Btn>
        }
      />
      <div className="toolbar">
        <Segmented<Os>
          value={os}
          onChange={setOs}
          options={[
            ["android", "Android (Play)"],
            ["ios", "iOS (App Store)"],
          ]}
        />
        <Segmented<string> value={channel} onChange={setChannel} options={channelNames.map((n): [string, string] => [n, n])} />
      </div>
      <div className="grid two">
        <Thresholds os={os} rules={rules.filter((r) => !r.isTest)} label={`For customers on ${channel}`} />
        <Thresholds os={os} rules={rules} label={`For test versions on ${channel}`} />
      </div>
      {noCustomerRule ? <Notice tone="blue">Only test rules exist. Customers are not asked to update.</Notice> : null}
      <Card title={<>Rules on <ChannelTag name={channel} /></>} right={<span className="muted small">Saving or deleting a rule tells the phones on {channel} to check now.</span>}>
        {rules.length === 0 ? (
          <Empty title={`No rules on ${channel} yet`}>Phones on {channel} are never asked to update. Add a rule to ask them.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>How strong</th>
                  <th>Test</th>
                  <th>Update screen text</th>
                  <th>Note</th>
                  <th>By</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td className="num strong">{showVersion(os, r.version)}</td>
                    <td>
                      <Badge tone={r.critical === 2 ? "red" : r.critical === 1 ? "amber" : "grey"}>{criticalWords(r.critical)}</Badge>
                    </td>
                    <td>{r.isTest ? <Badge tone="blue">Test version</Badge> : ""}</td>
                    <td>
                      {r.title ? <strong>{r.title}</strong> : null}
                      {r.message ? <div className="muted">{r.message}</div> : null}
                    </td>
                    <td>{r.note ?? ""}</td>
                    <td>{r.by}</td>
                    <td title={dateTime(r.at)}>
                      <When at={r.at} />
                    </td>
                    <td className="nowrap">
                      <Btn small onClick={() => c.open({ t: "rule", os, channel, rule: r })}>
                        Change
                      </Btn>{" "}
                      <Btn small kind="ghost" onClick={() => c.open({ t: "ruleDelete", os, rule: r })}>
                        Delete
                      </Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Checker key={`${os}-${channel}`} os={os} channel={channel} />
    </>
  )
}

// ---- Store builds & families ------------------------------------------------------------------------------------------

const CMD_BUNDLE = `bun run updates build <appDir> --name <app>
bun run updates upload <builtDir>`
const CMD_STORE = `bun run updates store-build <appDir> --name <app> --assets <host assets dir> --os android --channel production --label "production AAB" --version-code <n> --version-name <x.y.z>`

function Families({ s, href }: { s: State; href: (p: string) => string }) {
  const [all, setAll] = useState(false)
  const bundles = all ? s.bundles : s.bundles.slice(0, 12)
  const colours = needsColours(s)
  if (s.families.length === 0) {
    return (
      <Empty title="No families yet">
        A family is a group of store builds that can run exactly the same bundles. It appears when a store build's capabilities are known: the CLI sends them, or the first phone check fills them in.
      </Empty>
    )
  }
  return (
    <div className="stack">
      {s.families.map((f) => (
        <Card key={f.family} title={<span className="code">{f.family}</span>} right={<span className="muted small">{f.builds.length} store {f.builds.length === 1 ? "build" : "builds"}</span>}>
          <div className="chips-static">
            {f.builds.map((b) => {
              const needs = s.storeBuilds.find((x) => x.builtinSerial === b.builtinSerial && x.os === b.os && x.versionCode === b.versionCode)?.needs
              return (
                <span key={`${b.os}-${b.channel}-${b.versionCode}-${b.builtinSerial}`} className="chips-static">
                  <Badge tone="blue">
                    {b.label}: {b.os} {b.versionName} ({b.versionCode})
                  </Badge>
                  {needs ? <NeedsTag tag={needs} colour={colours.get(needs) ?? 0} same={sameNeeds(s, needs, b.builtinSerial)} /> : null}
                </span>
              )
            })}
          </div>
          <h4>What this app build has</h4>
          <div className="chips-static">
            {capabilityList(f.capabilities).map((x) => (
              <Badge key={x}>{x}</Badge>
            ))}
          </div>
          <h4>Can it run each bundle?</h4>
          {s.bundles.length === 0 ? (
            <p className="muted">No bundles yet.</p>
          ) : (
            <ul className="canrun">
              {bundles.map((b) => {
                const why = f.canRun[b.id]
                return (
                  <li key={b.id} className={why ? "no" : "yes"}>
                    <span className="mark">{why ? "✗" : "✓"}</span>
                    <a href={href(`/bundles/${b.serial}`)} className="num">
                      #{b.serial}
                    </a>
                    <span className="muted">{why ? `lacks: ${why}` : "can run"}</span>
                  </li>
                )
              })}
            </ul>
          )}
          {s.bundles.length > 12 ? (
            <Btn small kind="ghost" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${s.bundles.length}`}
            </Btn>
          ) : null}
        </Card>
      ))}
    </div>
  )
}

/** What a phone on this store build downloads for the newest bundle: a patch (from its base) or the full zip. */
function NextDownload({ s, b }: { s: State; b: StoreBuild }) {
  const newest = s.bundles.filter((x) => !x.deleteAt && x.serial > b.builtinSerial).sort((x, y) => y.serial - x.serial)[0]
  if (!newest) return <span className="muted">nothing newer</span>
  const patch = newest.patches.find((p) => p.fromSha256 === b.builtinSha256)
  return patch ? (
    <span title={`#${newest.serial}: a patch of ${bytes(patch.size)} instead of the full ${bytes(newest.manifest.zip.size)}`}>
      #{newest.serial}: <strong>{bytes(patch.size)}</strong> patch
    </span>
  ) : (
    <span title={b.baseSize === null ? "No patch base: phones get the full zip" : "No patch from this build to the newest bundle"}>
      #{newest.serial}: full zip, {bytes(newest.manifest.zip.size)}
    </span>
  )
}

function StoreBuildTable({ s, list, marked }: { s: State; list: StoreBuild[]; marked?: boolean }) {
  const c = useApp()
  const colours = needsColours(s)
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th>On the store</th>
            <th>Channel</th>
            <th>Version</th>
            <th>Built-in</th>
            <th title="The built-in bundle's zip kept as a base for patches">Patch base</th>
            <th title="What a phone on this build downloads to get the newest bundle">Next download</th>
            <th>Family</th>
            <th>Git</th>
            <th>Built</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((b) => (
            <tr key={b.id} data-needs={b.needs ? "" : undefined} style={b.needs ? needsVar(colours.get(b.needs) ?? 0) : undefined}>
              <td className="strong">
                {b.label}
                <div className="muted small">{b.os === "ios" ? "iOS" : "Android"}</div>
              </td>
              <td>
                {b.deleteAt ? (
                  <Badge tone="red" title={`Marked by ${b.deleteBy ?? "?"}: removed for good on ${dateOnly(b.deleteAt)}`}>
                    Deletes in {daysLeft(b.deleteAt)} {daysLeft(b.deleteAt) === 1 ? "day" : "days"}
                  </Badge>
                ) : b.liveAt ? (
                  <Badge tone="green" title={`Marked live by ${b.liveBy ?? "?"}, ${dateTime(b.liveAt)}: it and its built-in bundle can't be deleted`}>
                    Live on {b.os === "ios" ? "App Store" : "Play"}
                  </Badge>
                ) : (
                  <span className="muted">not marked</span>
                )}
              </td>
              <td>
                <ChannelTag name={b.channel} />
              </td>
              <td className="num">
                {b.versionName} ({b.versionCode})
              </td>
              <td className="num">
                <a href={c.href(`/bundles/${b.builtinSerial}`)}>#{b.builtinSerial}</a>
                {b.needs ? (
                  <div>
                    <NeedsTag tag={b.needs} colour={colours.get(b.needs) ?? 0} same={sameNeeds(s, b.needs, b.builtinSerial)} />
                  </div>
                ) : null}
              </td>
              <td>{b.baseSize ? bytes(b.baseSize) : <span className="muted">none</span>}</td>
              <td>{marked ? <span className="muted">-</span> : <NextDownload s={s} b={b} />}</td>
              <td>{b.family ? <span className="code">{b.family}</span> : <span className="muted">learning from the first phone</span>}</td>
              <td>
                <span className="code">{b.git.commit.slice(0, 7)}</span> {b.git.dirty ? <Badge tone="amber">uncommitted</Badge> : null}
              </td>
              <td title={dateTime(b.builtAt)}>
                {b.builtBy}, <When at={b.builtAt} />
              </td>
              <td>
                {b.deleteAt ? (
                  <Btn small kind="soft" onClick={() => c.open({ t: "storeBuild", id: b.id, mode: "undo" })}>
                    Keep it
                  </Btn>
                ) : (
                  // Buttons, not a menu: the table scrolls sideways and would cut a menu off
                  <div className="btn-row nowrap">
                    {b.liveAt ? (
                      <Btn small kind="ghost" onClick={() => c.open({ t: "storeBuild", id: b.id, mode: "unlive" })}>
                        Not live
                      </Btn>
                    ) : (
                      <Btn small kind="soft" onClick={() => c.open({ t: "storeBuild", id: b.id, mode: "live" })}>
                        Mark live
                      </Btn>
                    )}
                    <Btn small kind="ghost" disabled={!!b.liveAt} title={b.liveAt ? "Marked live on the store: take that mark off first" : undefined} onClick={() => c.open({ t: "storeBuild", id: b.id, mode: "delete" })}>
                      Delete
                    </Btn>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function StoreBuilds() {
  const c = useApp()
  const s = c.state!
  const kept = s.storeBuilds.filter((b) => !b.deleteAt)
  const marked = s.storeBuilds.filter((b) => b.deleteAt)
  return (
    <>
      <PageHead title="Store builds & families" sub="The app builds you put on Play and the App Store, and which bundles each can run." />
      <Card title="Store builds" right={<span className="muted small">Mark a build live when customers can download it: then nobody can delete it.</span>}>
        {kept.length === 0 ? (
          <Empty title="No store builds yet">Make one with the commands below. It reserves the built-in bundle's number.</Empty>
        ) : (
          <StoreBuildTable s={s} list={kept} />
        )}
      </Card>
      {marked.length ? (
        <Card title={`Marked for delete (${marked.length})`} right={<span className="muted small">Removed for good 30 days after the mark. Keep one to undo.</span>}>
          <StoreBuildTable s={s} list={marked} marked />
        </Card>
      ) : null}
      <h2 className="section">App build families</h2>
      <Families s={s} href={c.href} />
      <h2 className="section">Commands</h2>
      <div className="grid two">
        <CopyBlock label="OTA bundle" text={CMD_BUNDLE} />
        <CopyBlock label="Store build (then build the AAB or IPA as usual)" text={CMD_STORE} />
      </div>
      <p className="muted small">Run these on your laptop, in the zero-native folder. They sign with your key file there; the server never sees it.</p>
    </>
  )
}


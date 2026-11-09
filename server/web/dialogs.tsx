// Dialogs for every write. The server checks every rule again; each dialog explains its rules first.
import { type ReactNode, useState } from "react"
import { ApiError, type Priority, routes } from "./api"
import { channelNow, cannotRun, olderThanStoreBuilds, orderedChannels, PRODUCTION } from "./logic"
import { buildPointer, loadSigningKey } from "./sign"
import { Badge, Btn, Field, Modal, Notice, type DialogSpec, useApp } from "./ui"
import { BUILT_IN, criticalWords, PRIORITY_LINES, showVersion, versionNumber } from "./util"

// ---- Shared bits ------------------------------------------------------------------------------------------------------

function useAction() {
  const { reload } = useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; conflict: boolean } | null>(null)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError({ text: (e as Error).message, conflict: e instanceof ApiError && e.status === 409 })
    } finally {
      setBusy(false)
    }
  }
  const box = error ? (
    <Notice tone="red">
      <div>{error.text}</div>
      {error.conflict ? (
        <div className="mt">
          <Btn
            small
            onClick={async () => {
              await reload()
              setError(null)
            }}
          >
            Reload and start again
          </Btn>
        </div>
      ) : null}
    </Notice>
  ) : null
  return { busy, run, box }
}

/** Asks for the private key file, once per browser session. It stays in memory only. */
export function KeyPanel() {
  const { key, setKey, state } = useApp()
  const [err, setErr] = useState("")
  const keys = state?.app.publicKeys ?? []
  const idx = key ? keys.indexOf(key.publicKey) : -1
  const pick = async (f: File | undefined) => {
    if (!f) return
    setErr("")
    try {
      setKey(await loadSigningKey(await f.text()))
    } catch (e) {
      setKey(null)
      setErr((e as Error).message)
    }
  }
  const picker = (
    <label className="filepick">
      <input type="file" accept=".pem,.key,text/plain" onChange={(e) => void pick(e.target.files?.[0])} />
      <span className="btn soft small">Choose key file</span>
      <small>PKCS#8 PEM, starts with BEGIN PRIVATE KEY. It stays in this tab only: never saved, never sent.</small>
    </label>
  )
  if (key && idx >= 0) {
    return (
      <Notice tone="green">
        <div>
          Signing key <code>{key.keyId}</code> is loaded ({idx === 0 ? "main" : "backup"} key of this app).
        </div>
        <div className="mt">
          <Btn small kind="ghost" onClick={() => setKey(null)}>
            Remove key from this tab
          </Btn>
        </div>
      </Notice>
    )
  }
  return (
    <div className="keypanel">
      {key ? (
        <Notice tone="red">
          This key (<code>{key.keyId}</code>) is not one of this app's keys. Phones would refuse its signatures, so the dashboard will not sign with it. Choose another file.
        </Notice>
      ) : (
        <Notice tone="blue">Load your private key file to sign this change. The browser signs; the server never sees the key.</Notice>
      )}
      {err ? <Notice tone="red">{err}</Notice> : null}
      {picker}
    </div>
  )
}

function Foot({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <>
      <Btn kind="ghost" onClick={onClose}>
        Cancel
      </Btn>
      {children}
    </>
  )
}

function Problems({ list }: { list: string[] }) {
  if (list.length === 0) return null
  return (
    <ul className="problems">
      {list.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  )
}

// ---- Publish / roll back / rollout / kill -----------------------------------------------------------------------------

function ChangeDialog({ spec }: { spec: Extract<DialogSpec, { t: "change" }> }) {
  const c = useApp()
  const s = c.state!
  const { channel, mode } = spec
  const prod = channel === PRODUCTION
  const now = channelNow(s, channel)
  const bundle = spec.serial !== undefined ? s.bundles.find((b) => b.serial === spec.serial) : undefined
  const target = mode === "kill" ? BUILT_IN : mode === "rollout" ? (now.target ?? "") : (bundle?.id ?? "")
  const [rollout, setRollout] = useState(mode === "rollout" ? now.rollout : mode === "kill" ? 100 : prod && mode === "publish" ? 5 : 100)
  // The kill switch is always critical: phones go back to their built-in bundle as soon as they can.
  const [priority, setPriority] = useState<Priority>(mode === "rollout" ? now.priority : mode === "kill" ? "critical" : "normal")
  const [reason, setReason] = useState("")
  const [confirm, setConfirm] = useState("")
  const act = useAction()

  const need = mode === "kill" ? `KILL ${channel.toUpperCase()}` : (mode === "publish" || mode === "rollback") && prod && bundle ? `PRODUCTION #${bundle.serial}` : ""
  const problems: string[] = []
  if (mode !== "kill" && mode !== "rollout" && !bundle) problems.push("This bundle was not found. Reload the page.")
  if (mode === "rollout" && now.killed) problems.push(`${channel} is killed. Publish a bundle first.`)
  if (mode === "rollout" && now.empty) problems.push(`${channel} has nothing published yet.`)
  if (mode === "kill" && now.killed) problems.push(`${channel} is already killed. Publish a bundle to end the kill switch.`)
  if (mode === "kill" && now.empty) problems.push(`${channel} has nothing published: there is nothing to kill.`)
  if ((mode === "publish" || mode === "rollback") && bundle) {
    if (bundle.liveOn.includes(channel)) problems.push(`#${bundle.serial} is already live on ${channel}. Use "Change rollout" on the Channels page.`)
    if (prod) {
      const before = bundle.everOn.includes(PRODUCTION)
      if (!bundle.stableAt && !before) problems.push(`#${bundle.serial} is not marked stable. Publish it to staging, test it, then mark it stable.`)
      if (bundle.manifest.git.dirty) problems.push(`#${bundle.serial} was built from uncommitted changes. Production takes only bundles built from a commit.`)
    }
  }
  if (!Number.isInteger(rollout) || rollout < 1 || rollout > 100) problems.push("Rollout must be a whole number from 1 to 100.")
  if (mode === "rollout" && rollout === now.rollout && priority === now.priority) problems.push("Nothing changed yet.")
  if (prod && (mode === "kill" || mode === "rollback") && !reason.trim()) problems.push("A reason is needed here. It goes in the history for the next person.")
  if (need && confirm !== need) problems.push(`Type ${need} to confirm.`)

  const title =
    mode === "publish" ? `Publish #${bundle?.serial ?? "?"} to ${channel}` : mode === "rollback" ? `Roll back ${channel} to #${bundle?.serial ?? "?"}` : mode === "rollout" ? `Change rollout on ${channel}` : `Kill switch: ${channel}`
  const verb = mode === "publish" ? "Publish" : mode === "rollback" ? "Roll back" : mode === "rollout" ? "Save rollout" : `Kill ${channel}`
  const lacking = bundle ? cannotRun(s, bundle) : []
  const oldStore = bundle && (mode === "publish" || mode === "rollback") ? olderThanStoreBuilds(s, bundle, channel) : []
  const canSign = c.keyOk
  const blocked = problems.length > 0 || !canSign

  const submit = () =>
    act.run(async () => {
      if (!c.key) throw new Error("load your signing key first")
      const next = await routes.next(s.app.id, channel, target)
      // The page showed seq N. If the server is further on, someone else changed this channel since: stop and reload.
      if (next.seq !== now.seq + 1) {
        throw new ApiError(`${channel} was changed by someone else since you opened this page (it is at change ${next.seq - 1} now, you saw ${now.seq}). Nothing was changed. Reload and look again.`, 409)
      }
      const pointer = await buildPointer(c.key, { app: s.app.id, channel, seq: next.seq, text: next.text, target, rollout, priority, reason: reason.trim() || undefined })
      await routes.pointer(s.app.id, pointer, need || undefined)
      c.toast(mode === "kill" ? `${channel} killed` : mode === "rollout" ? `Rollout on ${channel} is ${rollout}%` : mode === "rollback" ? `${channel} rolled back to #${bundle?.serial}` : `#${bundle?.serial} published to ${channel}`)
      c.close()
      await c.reload()
    })

  return (
    <Modal title={title} onClose={c.close} footer={<Foot onClose={c.close}><Btn kind={mode === "kill" ? "danger" : "primary"} disabled={blocked} busy={act.busy} onClick={submit}>{verb}</Btn></Foot>}>
      <div className="dialog-stack">
        {mode === "kill" ? (
          <Notice tone="red">
            Phones on {channel} go back to the app's own bundle. This stops a bad bundle fast. Publish a bundle again to end it.
          </Notice>
        ) : null}
        {mode === "rollout" ? (
          <Notice tone="blue">
            You can set 1 to 100. To stop a bundle, roll back or use the kill switch: rollout cannot go to 0. Raising the rollout only adds phones; nobody who has the bundle loses it.
          </Notice>
        ) : null}
        {bundle && mode !== "kill" && mode !== "rollout" ? (
          <div className="kv">
            <span>Bundle</span>
            <strong>
              #{bundle.serial} <span className="muted">{bundle.gitSubject || "no git subject"}</span>
            </strong>
            <span>Customers see</span>
            <strong>{bundle.customerTitle ? `"${bundle.customerTitle}"` : <span className="muted">nothing (silent fix)</span>}</strong>
          </div>
        ) : null}
        {mode === "rollout" && now.serial !== null ? (
          <div className="kv">
            <span>Live now</span>
            <strong>
              #{now.serial} at {now.rollout}%
            </strong>
          </div>
        ) : null}
        {lacking.length ? (
          <Notice tone="amber">
            Some app builds cannot run #{bundle?.serial} and will keep what they have: {lacking.map((l) => `${l.labels.join(", ")} (${l.why})`).join("; ")}.
          </Notice>
        ) : null}
        {oldStore.length ? (
          <Notice tone="amber">
            Phones on {oldStore.map((x) => x.label).join(", ")} already have a built-in bundle #{Math.max(...oldStore.map((x) => x.builtinSerial))} or newer, so they will ignore #{bundle?.serial}.
          </Notice>
        ) : null}

        {mode !== "kill" ? (
          <Field label={`Rollout: ${rollout}% of phones`} hint={prod && mode === "publish" ? "Start small on production (5%), then raise it." : undefined}>
            <div className="slider">
              <input type="range" min={1} max={100} value={rollout} onChange={(e) => setRollout(Number(e.target.value))} />
              <input type="number" min={1} max={100} value={rollout} onChange={(e) => setRollout(Math.round(Number(e.target.value)))} aria-label="Rollout percent" />
            </div>
            <div className="chips">
              {[5, 25, 50, 100].map((n) => (
                <button key={n} type="button" className={`chip${rollout === n ? " on" : ""}`} onClick={() => setRollout(n)}>
                  {n}%
                </button>
              ))}
            </div>
          </Field>
        ) : null}
        {mode !== "kill" ? (
          <Field label="Priority" hint="How soon phones update. It is not signed: a wrong value only makes phones update sooner or later, never run a different bundle.">
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {(["normal", "high", "critical"] as const).map((p) => (
                <option key={p} value={p}>
                  {p === "critical" ? PRIORITY_LINES[p] : `${p === "normal" ? "Normal" : "High"}: ${PRIORITY_LINES[p]!.toLowerCase()}`}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label={prod && (mode === "kill" || mode === "rollback") ? "Reason (required)" : "Reason (optional)"} hint="Shown in the channel history.">
          <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={mode === "kill" ? "What went wrong?" : ""} />
        </Field>
        {need ? (
          <Field label={`Type ${need} to confirm`}>
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={need} autoCapitalize="off" autoComplete="off" spellCheck={false} />
          </Field>
        ) : null}
        <KeyPanel />
        <Problems list={problems} />
        {act.box}
      </div>
    </Modal>
  )
}

// ---- Stable -----------------------------------------------------------------------------------------------------------

function StableDialog({ spec }: { spec: Extract<DialogSpec, { t: "stable" }> }) {
  const c = useApp()
  const [note, setNote] = useState("")
  const act = useAction()
  const b = c.state!.bundles.find((x) => x.serial === spec.serial)
  const submit = () =>
    act.run(async () => {
      await routes.stable(c.appId, spec.serial, spec.on, note.trim() || undefined)
      c.toast(spec.on ? `#${spec.serial} marked stable` : `Stable mark removed from #${spec.serial}`)
      c.close()
      await c.reload()
    })
  return (
    <Modal title={spec.on ? `Mark #${spec.serial} stable` : `Remove stable mark from #${spec.serial}`} onClose={c.close} footer={<Foot onClose={c.close}><Btn kind="primary" busy={act.busy} onClick={submit}>{spec.on ? "Mark stable" : "Remove mark"}</Btn></Foot>}>
      <div className="dialog-stack">
        {spec.on ? (
          <>
            <p>Stable means: staging served this bundle and you tested it. Only stable bundles can go to production.</p>
            {b && !b.everOn.includes("staging") ? <Notice tone="red">Staging never served #{spec.serial}. Publish it to staging first.</Notice> : null}
            <Field label="What did you check? (optional)">
              <textarea rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: login, home, one payment on a Lava phone" />
            </Field>
          </>
        ) : (
          <p>
            Production will not take #{spec.serial} again unless it was on production before. If you want to stop it on production, use Roll back or the Kill switch.
          </p>
        )}
        {act.box}
      </div>
    </Modal>
  )
}

// ---- Customer title ---------------------------------------------------------------------------------------------------

function TitleDialog({ spec }: { spec: Extract<DialogSpec, { t: "title" }> }) {
  const c = useApp()
  const b = c.state!.bundles.find((x) => x.serial === spec.serial)
  const [title, setTitle] = useState(b?.customerTitle ?? "")
  const act = useAction()
  const t = title.trim()
  const submit = () =>
    act.run(async () => {
      await routes.title(c.appId, spec.serial, t)
      c.toast(t ? "Customer title saved" : "Customer title cleared: a silent fix")
      c.close()
      await c.reload()
    })
  return (
    <Modal title={`Customer title for #${spec.serial}`} onClose={c.close} footer={<Foot onClose={c.close}><Btn kind="primary" busy={act.busy} disabled={t.length > 30} onClick={submit}>Save title</Btn></Foot>}>
      <div className="dialog-stack">
        <Field label="Title" counter={`${t.length}/30`} hint="What customers see on the app's update strip. Leave it empty for a silent fix.">
          <input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Faster receipts" />
        </Field>
        <div className="preview">
          <small>Customers see</small>
          <strong>{t ? t : <span className="muted">Nothing: a silent fix</span>}</strong>
        </div>
        {t.length > 30 ? <Notice tone="red">At most 30 characters.</Notice> : null}
        {act.box}
      </div>
    </Modal>
  )
}

// ---- Delete bundle ----------------------------------------------------------------------------------------------------

function DeleteDialog({ spec }: { spec: Extract<DialogSpec, { t: "delete" }> }) {
  const c = useApp()
  const act = useAction()
  const submit = () =>
    act.run(async () => {
      await routes.deleteBundle(c.appId, spec.serial)
      c.toast(`#${spec.serial} deleted`)
      c.go("/bundles")
      c.close()
      await c.reload()
    })
  return (
    <Modal title={`Delete #${spec.serial}`} onClose={c.close} footer={<Foot onClose={c.close}><Btn kind="danger" busy={act.busy} onClick={submit}>Delete #{spec.serial}</Btn></Foot>}>
      <div className="dialog-stack">
        <ul className="plain">
          <li>Only the newest bundle can be deleted, and never one that was on production.</li>
          <li>The number #{spec.serial} stays used. It is never given to another bundle.</li>
          <li>A phone that ran it on staging keeps it until the next update.</li>
          <li>This cannot be undone. You would have to build it again.</li>
        </ul>
        {act.box}
      </div>
    </Modal>
  )
}

// ---- Store rules ------------------------------------------------------------------------------------------------------

function RuleDialog({ spec }: { spec: Extract<DialogSpec, { t: "rule" }> }) {
  const c = useApp()
  const { os, rule } = spec
  // A rule belongs to one channel: a new rule starts on the channel the page shows, a saved one keeps its own.
  const [channel, setChannel] = useState(rule?.channel ?? spec.channel)
  const channelNames = orderedChannels(c.state!).map((x) => x.name)
  const [version, setVersion] = useState(rule ? showVersion(os, rule.version) : "")
  const [critical, setCritical] = useState<0 | 1 | 2>(rule?.critical ?? 1)
  const [isTest, setIsTest] = useState(rule?.isTest ?? false)
  const [title, setTitle] = useState(rule?.title ?? "")
  const [message, setMessage] = useState(rule?.message ?? "")
  const [note, setNote] = useState(rule?.note ?? "")
  const [confirm, setConfirm] = useState("")
  const act = useAction()
  const n = versionNumber(os, version)
  const shown = n === null ? "" : showVersion(os, n)
  const need = critical === 2 && !isTest && n !== null ? `FORCE UPDATE ${shown}` : ""
  const problems: string[] = []
  if (n === null) problems.push(os === "ios" ? "Version must look like 1.6.2." : "Version must be a versionCode (a whole number).")
  if (need && confirm !== need) problems.push(`Type ${need} to confirm.`)
  const submit = () =>
    act.run(async () => {
      await routes.saveRule(c.appId, {
        os,
        channel,
        version: os === "ios" ? version.trim() : Number(version),
        critical,
        isTest,
        title: title.trim() || undefined,
        message: message.trim() || undefined,
        note: note.trim() || undefined,
        confirm: need || undefined,
      })
      c.toast(`Rule for ${shown} saved on ${channel}`)
      c.close()
      await c.reload()
    })
  const what =
    critical === 0
      ? "None: this version is fine. It does not ask anyone to update."
      : critical === 1
        ? `Optional: phones below ${shown || "this version"} are asked to update. They can say later.`
        : `Forced: phones below ${shown || "this version"} must update before they can go on.`
  return (
    <Modal title={rule ? `Change rule for ${shown} (${channel})` : `Add a rule (${os === "ios" ? "App Store" : "Play"})`} onClose={c.close} footer={<Foot onClose={c.close}><Btn kind={critical === 2 && !isTest ? "danger" : "primary"} busy={act.busy} disabled={problems.length > 0} onClick={submit}>Save rule</Btn></Foot>}>
      <div className="dialog-stack">
        <Field label="Channel" hint={`Only phones on ${channel} are told about this rule. Saving it also tells those phones to check now.`}>
          <select value={channel} disabled={!!rule} onChange={(e) => setChannel(e.target.value)}>
            {channelNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label={os === "ios" ? "Version (like 1.6.2)" : "Version code (a whole number)"}>
          <input value={version} disabled={!!rule} inputMode={os === "ios" ? "text" : "numeric"} onChange={(e) => setVersion(e.target.value)} placeholder={os === "ios" ? "1.6.2" : "150"} />
        </Field>
        <Field label="How strong" hint={what}>
          <select value={critical} onChange={(e) => setCritical(Number(e.target.value) as 0 | 1 | 2)}>
            <option value={0}>None</option>
            <option value={1}>Optional</option>
            <option value={2}>Forced</option>
          </select>
        </Field>
        <label className="check">
          <input type="checkbox" checked={isTest} onChange={(e) => setIsTest(e.target.checked)} />
          <span>
            Test version <small>(only test builds see this rule: Play internal sharing, TestFlight. Customers see nothing.)</small>
          </span>
        </label>
        <Field label="Title on the app's update screen (optional)">
          <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Update available" />
        </Field>
        <Field label="Message on the app's update screen (optional)">
          <textarea rows={2} maxLength={300} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="The app has a new look and fixes." />
        </Field>
        <Field label="Note for the team (optional)">
          <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Why this rule?" />
        </Field>
        {critical === 2 && !isTest ? (
          <>
            <Notice tone="red">A forced rule stops every customer on an older version at the door. Be sure the new version is live in the store.</Notice>
            <Field label={`Type ${need || "FORCE UPDATE <version>"} to confirm`}>
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={need} autoComplete="off" spellCheck={false} />
            </Field>
          </>
        ) : null}
        <Problems list={problems} />
        {act.box}
      </div>
    </Modal>
  )
}

function RuleDeleteDialog({ spec }: { spec: Extract<DialogSpec, { t: "ruleDelete" }> }) {
  const c = useApp()
  const act = useAction()
  const v = showVersion(spec.os, spec.rule.version)
  const submit = () =>
    act.run(async () => {
      await routes.deleteRule(c.appId, spec.rule.channel, spec.os, spec.rule.version)
      c.toast(`Rule for ${v} deleted from ${spec.rule.channel}`)
      c.close()
      await c.reload()
    })
  return (
    <Modal title={`Delete the rule for ${v} (${spec.rule.channel})`} onClose={c.close} footer={<Foot onClose={c.close}><Btn kind="danger" busy={act.busy} onClick={submit}>Delete rule</Btn></Foot>}>
      <div className="dialog-stack">
        <p>
          This is a <Badge tone={spec.rule.critical === 2 ? "red" : "grey"}>{criticalWords(spec.rule.critical)}</Badge> rule{spec.rule.isTest ? " for test versions" : ""} on the {spec.rule.channel} channel. After you delete it, phones on {spec.rule.channel} stop being asked because of it.
        </p>
        {act.box}
      </div>
    </Modal>
  )
}

function KeyDialog() {
  const c = useApp()
  return (
    <Modal title="Signing key" onClose={c.close} footer={<Btn onClick={c.close}>Done</Btn>}>
      <div className="dialog-stack">
        <KeyPanel />
        <p className="muted">You need the key to publish, roll back, change rollout and use the kill switch. Store rules, stable marks and titles do not need it.</p>
      </div>
    </Modal>
  )
}

export function DialogHost({ spec }: { spec: DialogSpec | null }) {
  if (!spec) return null
  switch (spec.t) {
    case "change":
      return <ChangeDialog spec={spec} />
    case "stable":
      return <StableDialog spec={spec} />
    case "title":
      return <TitleDialog spec={spec} />
    case "delete":
      return <DeleteDialog spec={spec} />
    case "rule":
      return <RuleDialog spec={spec} />
    case "ruleDelete":
      return <RuleDeleteDialog spec={spec} />
    case "key":
      return <KeyDialog />
  }
}

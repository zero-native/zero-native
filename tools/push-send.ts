// Sends one FCM test message to the sample (plugins/firebase-messaging), with the FCM HTTP v1 API and your own gcloud login:
//
//   bun run tools/push-send.ts --token <FCM token> --data lab=show,title=Hello,body=From the computer
//   bun run tools/push-send.ts --topic zn-sample-lab --data lab=show --notification "Title|Body"
//   bun run tools/push-send.ts --token <FCM token> --background --data lab=show,title=Quiet
//   bun run tools/push-send.ts --sim booted --data lab=show --notification "Title|Body"
//
// Options: --token or --topic (one of them), --data k=v,k=v (all strings), --notification "title|body",
// --priority high|normal (default high), --project <id> (default: the sample's, from android/sample/google-services.json or ios/Sample/GoogleService-Info.plist),
// --image <https url> (a picture: Android's notification image, and on iOS FCM's image with "mutable-content": 1, so the
// notification service extension downloads and attaches it), --background (a data-only push that wakes an iOS app:
// the apns block Apple asks for, `apns-push-type: background`, `apns-priority: 5`, `content-available: 1`, and no
// notification; iOS rations these and never wakes an app the user closed),
// --sim <simulator> (no FCM: the payload FCM would give the app, with a made-up message id, sent with
// `xcrun simctl push` to the sample on that booted simulator; --bundle-id <id> for another app). The iOS 26 simulator
// gives a --background one to the app's scene but not to its app delegate (2026-11-21), so it reaches no code: the
// sample's debug hook does instead (`notifyutil -p dev.zeronative.sample.push.data`, ios/Sample/ZnSampleApp.swift).
// The access token comes from `gcloud auth print-access-token` (your account needs FCM rights on the project). Nothing
// here prints a token: only the FCM message name, or FCM's error.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

const token = arg("token")
const topic = arg("topic")
const sim = arg("sim")
if ([token, topic, sim].filter(Boolean).length !== 1) {
  console.error("give exactly one of --token <FCM token>, --topic <name> or --sim <simulator>")
  process.exit(2)
}
const background = process.argv.includes("--background")

/** The sample's Firebase project: android/sample/google-services.json, else ios/Sample/GoogleService-Info.plist (a Mac). */
function sampleProject(): string {
  const root = join(import.meta.dir, "..")
  const android = join(root, "android", "sample", "google-services.json")
  if (existsSync(android)) return (JSON.parse(readFileSync(android, "utf8")) as { project_info: { project_id: string } }).project_info.project_id
  const plist = readFileSync(join(root, "ios", "Sample", "GoogleService-Info.plist"), "utf8")
  const id = /<key>PROJECT_ID<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
  if (!id) throw new Error("no PROJECT_ID in ios/Sample/GoogleService-Info.plist: pass --project <id>")
  return id
}

const data: Record<string, string> = {}
for (const pair of (arg("data") ?? "").split(",").filter(Boolean)) {
  const at = pair.indexOf("=")
  if (at < 1) {
    console.error(`--data: "${pair}" is not k=v`)
    process.exit(2)
  }
  data[pair.slice(0, at)] = pair.slice(at + 1)
}
const [title, body] = (arg("notification") ?? "").split("|")
const priority = arg("priority") === "normal" ? "NORMAL" : "HIGH"
const image = arg("image")
if (image && !/^https:\/\//.test(image)) {
  console.error("--image must be an https url")
  process.exit(2)
}

if (background && title) {
  console.error("--background sends no notification: leave out --notification")
  process.exit(2)
}

if (sim) {
  // What FCM hands the app delegate for such a message: the data keys at the top, aps, and FCM's own keys
  const id = `sim-${Date.now()}`
  const aps = background
    ? { "content-available": 1 }
    : { ...(title ? { alert: { title, ...(body ? { body } : {}) } } : {}), ...(image ? { "mutable-content": 1 } : {}) }
  const payload = { aps, ...data, "gcm.message_id": id, from: "simctl" }
  const file = join(tmpdir(), `zn-push-${id}.apns`)
  writeFileSync(file, JSON.stringify(payload))
  const r = spawnSync("xcrun", ["simctl", "push", sim, arg("bundle-id") ?? "dev.zeronative.sample", file], { encoding: "utf8" })
  rmSync(file, { force: true })
  if (r.status !== 0) {
    console.error(`simctl push failed: ${(r.stderr || r.stdout).trim()}`)
    process.exit(1)
  }
  console.log(`sent ${id} to ${sim} (${Object.keys(data).length} data keys${background ? ", background" : title ? ", with a notification" : ""})`)
  process.exit(0)
}

const project = arg("project") ?? sampleProject()
const gcloud = spawnSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", shell: true })
const access = gcloud.stdout.trim()
if (gcloud.status !== 0 || !access) {
  console.error(`gcloud gave no access token (run \`gcloud auth login\` first): ${gcloud.stderr.trim().split("\n").at(-1)}`)
  process.exit(1)
}

// A background push: Apple's headers and content-available, or APNs drops it (or delivers it late)
const apns = background
  ? { headers: { "apns-push-type": "background", "apns-priority": "5" }, payload: { aps: { "content-available": 1 } } }
  : image
    ? { payload: { aps: { "mutable-content": 1 } }, fcm_options: { image } }
    : undefined
const message = {
  ...(token ? { token } : { topic }),
  data,
  ...(title ? { notification: { title, ...(body ? { body } : {}), ...(image ? { image } : {}) } } : {}),
  android: { priority },
  ...(apns ? { apns } : {}),
}
const res = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
  method: "POST",
  headers: { authorization: `Bearer ${access}`, "content-type": "application/json", "x-goog-user-project": project },
  body: JSON.stringify({ message }),
})
const text = await res.text()
if (!res.ok) {
  console.error(`FCM refused it (${res.status}): ${text.slice(0, 400)}`)
  process.exit(1)
}
console.log(`sent ${(JSON.parse(text) as { name: string }).name} (${Object.keys(data).length} data keys${title ? ", with a notification" : ""}${background ? ", background" : ""}, ${priority.toLowerCase()})`)

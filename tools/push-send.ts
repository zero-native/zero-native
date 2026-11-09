// Sends one FCM test message to the sample (plugins/firebase-messaging), with the FCM HTTP v1 API and your own gcloud login:
//
//   bun run tools/push-send.ts --token <FCM token> --data lab=show,title=Hello,body=From the computer
//   bun run tools/push-send.ts --topic zn-sample-lab --data lab=show --notification "Title|Body"
//
// Options: --token or --topic (one of them), --data k=v,k=v (all strings), --notification "title|body",
// --priority high|normal (default high), --project <id> (default: project_id of android/sample/google-services.json).
// The access token comes from `gcloud auth print-access-token` (your account needs FCM rights on the project). Nothing
// here prints a token: only the FCM message name, or FCM's error.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

const token = arg("token")
const topic = arg("topic")
if (!token === !topic) {
  console.error("give exactly one of --token <FCM token> or --topic <name>")
  process.exit(2)
}

const project =
  arg("project") ??
  (JSON.parse(readFileSync(join(import.meta.dir, "..", "android", "sample", "google-services.json"), "utf8")) as { project_info: { project_id: string } })
    .project_info.project_id

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

const gcloud = spawnSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", shell: true })
const access = gcloud.stdout.trim()
if (gcloud.status !== 0 || !access) {
  console.error(`gcloud gave no access token (run \`gcloud auth login\` first): ${gcloud.stderr.trim().split("\n").at(-1)}`)
  process.exit(1)
}

const message = {
  ...(token ? { token } : { topic }),
  data,
  ...(title ? { notification: { title, ...(body ? { body } : {}) } } : {}),
  android: { priority },
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
console.log(`sent ${(JSON.parse(text) as { name: string }).name} (${Object.keys(data).length} data keys${title ? ", with a notification" : ""}, ${priority.toLowerCase()})`)

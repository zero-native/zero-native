// Adds the Remote Config lab's parameter to the SAMPLE Firebase project, once: zn_lab_greeting = "hello from Remote
// Config". It keeps every other parameter (it reads the template, adds one key, writes it back with its ETag).
//   bun run tools/remote-config-lab.ts [--value "new text"]      (needs `gcloud auth login` with access to the project)
// Only for the zero-native sample project. Never point it at a real app's project.
import { spawnSync } from "node:child_process"

const PROJECT = "zero-native-sample"
const KEY = "zn_lab_greeting"
const i = process.argv.indexOf("--value")
const wanted = i > 0 ? process.argv[i + 1] : "hello from Remote Config"

const gcloud = spawnSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", shell: true })
const token = gcloud.stdout.trim()
if (gcloud.status !== 0 || !token) {
  console.error("gcloud gave no access token: run `gcloud auth login` first")
  process.exit(1)
}
const url = `https://firebaseremoteconfig.googleapis.com/v1/projects/${PROJECT}/remoteConfig`
const headers = { authorization: `Bearer ${token}`, "x-goog-user-project": PROJECT }

const got = await fetch(url, { headers: { ...headers, "accept-encoding": "gzip" } })
if (!got.ok) {
  console.error(`reading the template failed (${got.status}): ${(await got.text()).slice(0, 300)}`)
  process.exit(1)
}
const etag = got.headers.get("etag") ?? "*"
const template = (await got.json()) as { parameters?: Record<string, { defaultValue?: { value?: string } }> } & Record<string, unknown>
const now = template.parameters?.[KEY]?.defaultValue?.value
if (now === wanted) {
  console.log(`${KEY} is already "${wanted}"`)
  process.exit(0)
}
template.parameters = { ...(template.parameters ?? {}), [KEY]: { defaultValue: { value: wanted }, ...{ description: "zero-native Remote Config lab", valueType: "STRING" } } as never }
delete (template as Record<string, unknown>).version // the server sets it
const put = await fetch(url, {
  method: "PUT",
  headers: { ...headers, "content-type": "application/json; UTF-8", "if-match": etag },
  body: JSON.stringify(template),
})
if (!put.ok) {
  console.error(`writing the template failed (${put.status}): ${(await put.text()).slice(0, 300)}`)
  process.exit(1)
}
console.log(`${KEY} = "${wanted}" in ${PROJECT} (was ${now === undefined ? "not there" : `"${now}"`})`)

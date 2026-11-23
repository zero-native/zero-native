// The GitHub Release notes for a zero-native version (release.yml; repo-only, not in @zeronative/cli): where to get it, and the four contract numbers an
// app author needs (docs/publishing-plan.md §6): the registry, the host API, the Hermes bytecode format and Hermes.
//
//   bun run tools/release-notes.ts --version 0.1.0 [--bytecode <main.hbc of any built bundle>]
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { HOST_API_VERSION, NATIVE_ONLY_HOST_API } from "../packages/core/src/host-api"
import { REGISTRY_VERSION } from "../packages/template/src/registry"
import { bytecodeVersion } from "./hermesc"
import { hermesPins } from "./check-release"

const root = resolve(import.meta.dir, "..")
const { values } = parseArgs({ options: { version: { type: "string" }, bytecode: { type: "string" } } })
const v = (values.version ?? "").replace(/^v/, "")
if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error("--version <x.y.z>")
const hbc = values.bytecode ?? join(root, "android/sample/src/main/assets/main.hbc")
const bytecode = await bytecodeVersion(hbc)
const hermes = hermesPins().fetchScript
// The number apps of this release say (kHostApiVersion): the bundles' one plus its native-only steps, if any.
let nativeHostApi = HOST_API_VERSION
while (NATIVE_ONLY_HOST_API.includes(nativeHostApi + 1)) nativeHostApi++
const hostApi = nativeHostApi === HOST_API_VERSION ? `${HOST_API_VERSION}` : `${HOST_API_VERSION} (apps say ${nativeHostApi}: a native-only step, bundles still need ${HOST_API_VERSION})`

console.log(`zero-native ${v}.

| | |
|---|---|
| Registry | ${REGISTRY_VERSION} |
| Host API | ${hostApi} |
| Hermes bytecode | ${bytecode} |
| Hermes | ${hermes} |

An OTA bundle runs on an app only when the app has at least this registry and host API and the same bytecode format
(docs/ota.md). A release that raises the registry or the host API needs a new store build of the app.

- npm: \`@zeronative/core@${v}\`, \`@zeronative/ui@${v}\`, \`@zeronative/cli@${v}\` (the \`zn\` command) and the plugins
- Maven Central: \`io.github.zero-native:runtime:${v}\` and \`io.github.zero-native:plugin-<name>:${v}\`
- Swift packages, all at exactly ${v}: \`https://github.com/zero-native/zero-native.git\`, and for Firebase or Lottie
  \`zero-native-firebase\`, \`zero-native-lottie\`
`)

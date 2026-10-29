// Sample app entry: starts the runtime and renders the first screen on the root instance native created.
import { installRuntime, renderRoot } from "@zero-native/core"
import { AmountScreen } from "./AmountScreen"

installRuntime()

// The first screen's root instance. Native creates screen roots and uses the top bit for the ids it allocates
// (ARCHITECTURE §8.3). Until navigation exists (milestone 2) the sample hard-codes the first one on both sides.
const ROOT = 0x80000001

renderRoot(ROOT, AmountScreen, {})
console.info("sample: AmountScreen rendered")

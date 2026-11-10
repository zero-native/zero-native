// Fixture for modules.test.ts (docs/ota-requires-per-os.md): modules called from an Android-only plugin, an iOS-only
// plugin, a plugin for both, and the app itself.
import { nativeModule } from "@zero-native/core"
import { adId } from "./droid/src"
import { haptic } from "./apple/src"
import { share } from "./both/src"

const Pay = nativeModule<{ pay(): Promise<void> }>("Pay")
export const all = [adId, haptic, share, Pay]

import { nativeModule } from "@zero-native/core"
export const haptic = nativeModule<object>("Haptics", { version: 2 })

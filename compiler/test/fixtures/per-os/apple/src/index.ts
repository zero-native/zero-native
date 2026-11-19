import { nativeModule } from "@zeronative/core"
export const haptic = nativeModule<object>("Haptics", { version: 2 })

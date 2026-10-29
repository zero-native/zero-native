// The keyboard (milestone 3 step 3.3). Built-in native module: android/runtime/.../ZnKeyboard.kt.
import { nativeModule } from "./calls"

export interface KeyboardModule {
  /** Closes the keyboard and takes focus away from the focused <TextField> (it gets onBlur). */
  dismiss(): Promise<void>
}

export const Keyboard = nativeModule<KeyboardModule>("Keyboard", { version: 1 })

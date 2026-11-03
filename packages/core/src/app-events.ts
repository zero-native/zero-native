// App-level events: native → JS events that belong to the app, not to a screen node (instance 0). Every number is
// listed here once, and android/runtime/.../ZnAppEvent.kt must say the same (a test compares them). Two parts of the
// runtime using one number would silently take each other's events: step 3.9 gave RETRY the number of native call
// answers (7), and every native call answered after the app started was dropped (found in step 4.5).

/** The instance app-level events use (no node has id 0). */
export const APP = 0

export const AppEvent = {
  /** The first stack native opened (nav.ts). */
  Start: 1,
  /** The system back button or gesture (nav.ts). */
  Back: 2,
  /** Native went back by itself after JS didn't answer in time (nav.ts). */
  ForcedBack: 3,
  /** A deep link while the app runs (nav.ts). */
  Open: 4,
  /** Safe-area insets changed (insets.ts). */
  Insets: 5,
  /** Impression keys counted on a screen (nav.ts). */
  Impressions: 6,
  /** A native call's answer, JSON (calls.ts). */
  CallResult: 7,
  /** A native module's event (calls.ts). */
  ModuleEvent: 8,
  /** A native call's answer with binary data (calls.ts). */
  CallResultBytes: 9,
  /** "Try again" on a screen's error screen (nav.ts, step 3.9). */
  Retry: 10,
  /** "active" or "background" (app-state.ts). */
  AppState: 11,
  /** A native screen answered (nav.ts). */
  NavResult: 12,
  /** Run a background task (tasks.ts). */
  Task: 13,
  /** "light" or "dark" (appearance.ts). */
  ColorScheme: 14,
  /** Android asked the app to free memory (appearance.ts). */
  LowMemory: 15,
  /** Fixed facts about the phone, once after the main script (platform.ts). */
  Device: 16,
  /** The window's size, pixel density and font scale changed (dimensions.ts). */
  Window: 17,
  /** The keyboard was shown or hidden, with its height (keyboard.ts). */
  Keyboard: 18,
} as const

// The lottie plugin's JS side. Native side: android/.../LottiePlugin.kt. No side effects: nativeModule() only creates a handle.
// `import LottieView from "@zeronative/lottie"` works as in lottie-react-native (the default export), and so does the named import.
import { LottieView } from "./LottieView"

export { LottieView }
export default LottieView
export {
  Lottie,
  type LottieInfo,
  type LottieNativeModule,
  type LottiePreload,
  type LottieReason,
  type LottieRef,
  type LottieSource,
  type LottieViewController,
  type LottieViewProps,
} from "./api"

// A Lottie animation, with lottie-react-native's names. The component only passes things on: playing, the "remove
// animations" setting and the file rules are in Kotlin (LottieView.kt).
import { onCleanup } from "@zero-native/core"
import { NativeView } from "@zero-native/ui"
import { lottieController, lottieProps, onLottieEvent, setRef, type LottieViewController, type LottieViewProps } from "./api"

/**
 * Fills its parent: put the size on a `View` around it (`style` can't be passed through a component). Only plays while its
 * screen is on top and the app is in front.
 */
export function LottieView(p: LottieViewProps) {
  const controller = lottieController()
  const ref = p.ref
  setRef(ref, controller)
  onCleanup(() => setRef(ref, null))
  return <NativeView name="lottie.view" props={lottieProps(p, controller)} onEvent={(e) => onLottieEvent(p, e)} style={{ width: "100%", height: "100%" }} />
}

/** RN code keeps `LottieView` as the ref's type: `useRef<LottieView | null>(null)`, `Map<number, LottieView>`. */
export type LottieView = LottieViewController

// The photo viewer screen, in TSX (registry 24; ImageViewer module 3). ImageViewer.open pushes it; the app adds it to
// its routes once:
//   imageViewer: { path: "/image-viewer", screen: ImageViewerScreen, transparent: true, safeArea: "none", statusBar: "light", restore: false }
// The gestures are zero-native's own (useZoom per photo, usePan to drag it away), the pager is a <List pagingEnabled>,
// and the overlay (close button, counter) is TSX, so apps can restyle it. Each photo is drawn by the native view
// "imageviewer.page" (ViewerPage.kt): loading (web, asset, file, data:, headers), EXIF, the sharp part when zoomed.
// The flight from the thumbnail, the drag down and Back all move motion values natively; JS hears only the ends.
import { Column, List, NativeView, Pressable, Row, Stack, Text } from "@zero-native/ui"
import {
  derive,
  Dimensions,
  effect,
  env,
  listController,
  nav,
  onCleanup,
  signal,
  useBack,
  useMotion,
  usePan,
  useZoom,
  type MotionSource,
} from "@zero-native/core"
import { finishViewer, viewerFor, type ViewerRect } from "./open"

/** The screen's props: the key of the viewer ImageViewer.open made (its options live in JS, not in the route). */
export interface ImageViewerScreenProps {
  v?: string
}

const FLY_MS = 280
/** The flight waits for the start photo this long at most (ms): a slow link fades in under the spinner instead. */
const WAIT_MS = 400
/** A drag this far (dp), or this fast (dp/s), closes the viewer. */
const CLOSE_DRAG = 120
const CLOSE_SPEED = 1000

export function ImageViewerScreen(props: ImageViewerScreenProps) {
  const o = viewerFor(props.v)
  // Opened without ImageViewer.open (a link, a restore): nothing to show, so leave.
  if (!o) return <ViewerGone />
  const count = o.images.length
  const page = signal(o.index)
  const width = Dimensions.get("window").width
  // 0: at the thumbnail (or hidden), 1: open. Drives the flight, the backdrop and the overlay.
  const shown = useMotion(0)
  // The photo's place while dragged away (dp). Not zoomed only: a zoomed photo takes one finger itself.
  const drag = usePan({
    axis: "y",
    rubber: false,
    onEnd: (e) => {
      const y = e.y ?? 0
      if (o.swipeToClose && (Math.abs(y) > CLOSE_DRAG || Math.abs(e.vy ?? 0) > CLOSE_SPEED)) close()
      else void drag.y.to(0, "spring")
    },
  })
  const pager = listController()
  pager.scrollToIndex({ index: o.index, animated: false })
  let closing = false

  const from = o.from
  // The start photo's shape (w / h), once it loads: the flight lands on the photo, not the screen.
  const aspect = useMotion(from ? from.width / Math.max(1, from.height) : 1)
  // 1 while the start photo should fly (from a thumbnail); 0 to only fade.
  const flying = useMotion(from ? 1 : 0)

  // Open: from the thumbnail, or a fade. It waits for the start photo (a cached one loads in a frame or two), else
  // the flight would be over before there is a photo to fly.
  let started = false
  const start = () => {
    if (started || closing) return // closed before the photo came: don't open again
    started = true
    void shown.to(1, { duration: FLY_MS, easing: "standard" })
  }
  const wait = setTimeout(start, WAIT_MS)
  onCleanup(() => clearTimeout(wait))

  const close = () => {
    if (closing) return
    closing = true
    clearTimeout(wait)
    const back = page() === o.index && from ? { duration: FLY_MS, easing: "standard" as const } : { duration: 180, easing: "standard" as const }
    if (!(page() === o.index && from)) flying.set(0) // another photo: fade, don't fly to a thumbnail it isn't
    void drag.y.to(0, back)
    void shown.to(0, back).then(() => finishViewer(props.v, { index: page() }))
  }
  // Back plays the open backwards, then leaves.
  useBack(() => {
    close()
    return true
  })

  // Where the photo is drawn fitted on the screen, and the thumbnail's box: the flight maps one onto the other.
  const fx = from ? from.x + from.width / 2 : 0
  const fy = from ? from.y + from.height / 2 : 0
  const fw = from ? from.width : 1
  const fitW = derive(() => Math.min(env.width(), env.height() * aspect()))
  const flyScale = derive(() => 1 + (fw / Math.max(1, fitW()) - 1) * (1 - shown()) * flying())
  const flyX = derive(() => (fx - env.width() / 2) * (1 - shown()) * flying())
  const flyY = derive(() => (fy - env.height() / 2) * (1 - shown()) * flying())
  // The backdrop fades with the open and as the photo is dragged away.
  const backdrop = derive(() => shown() * (1 - 0.7 * Math.min(1, Math.abs(drag.y()) / 300)))

  return (
    <Stack style={{ flex: 1 }}>
      <Column style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, backgroundColor: o.backgroundColor, opacity: backdrop }} />
      <Column
        gesture={drag}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          start: 0,
          end: 0,
          opacity: derive(() => (flying() > 0.5 ? 1 : shown())),
          transform: [
            { translateX: flyX },
            { translateY: derive(() => flyY() + drag.y()) },
            { scale: derive(() => flyScale() * (1 - 0.15 * Math.min(1, Math.abs(drag.y()) / 400))) },
          ],
        }}
      >
        <List
          horizontal
          pagingEnabled
          controller={pager}
          data={o.images.map((img, i) => ({ ...img, i }))}
          key={(img) => String(img.i)}
          onMomentumScrollEnd={(e) => {
            const p = Math.round(e.nativeEvent.contentOffset.x / Math.max(1, e.nativeEvent.layoutMeasurement.width))
            if (p !== page()) {
              page.set(p)
              flying.set(0) // the flight back only fits the photo it came from
            }
          }}
          style={{ flex: 1 }}
          row={(img) => (
            <ViewerPhoto
              width={width}
              uri={img.uri}
              alt={img.alt ?? label(o.photoLabel, img.i, count)}
              held={o.held}
              i={img.i}
              page={page}
              doubleTap={o.doubleTap}
              errorText={o.errorText}
              retryLabel={o.retryLabel}
              aspect={img.i === o.index ? aspect : null}
              onReady={img.i === o.index ? start : null}
            />
          )}
        />
      </Column>
      {/* The bar: close and the count, over a dark fade, under the status bar. It fades with the backdrop. */}
      <Column style={{ position: "absolute", top: 0, start: 0, end: 0, opacity: backdrop, paddingBottom: 24, backgroundColor: "rgba(0,0,0,0.35)" }}>
        <Column style={{ height: env.insets.top }} />
        <Row style={{ height: 56, alignItems: "center", paddingHorizontal: 4 }}>
          <Pressable onPress={close} accessibilityLabel={o.closeLabel} style={{ width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" }}>
            <Text fontSize={22} color="#FFFFFF">
              ✕
            </Text>
          </Pressable>
          {count > 1 ? (
            <Text fontSize={16} fontWeight={600} color="#FFFFFF" style={{ flex: 1, textAlign: "center", marginEnd: 48 }} accessibilityLabel={label(o.photoLabel, page(), count)}>
              {`${page() + 1} / ${count}`}
            </Text>
          ) : null}
        </Row>
      </Column>
    </Stack>
  )
}

/** The screen with no viewer behind it: leaves at once. */
function ViewerGone() {
  void Promise.resolve().then(() => nav.back())
  return <Column style={{ flex: 1 }} />
}

/** One photo: its own zoom; the native page draws it moved by the zoom's values. */
function ViewerPhoto(p: {
  width: number
  uri: string
  alt: string
  held: string | undefined
  i: number
  page: () => number
  doubleTap: boolean
  errorText: string
  retryLabel: string
  aspect: ReturnType<typeof useMotion> | null
  /** The start photo: called once it has loaded or failed. */
  onReady: (() => void) | null
}) {
  const aspect = p.aspect ?? useMotion(0)
  const zoom = useZoom({ max: 5, doubleTap: p.doubleTap ? 2.5 : false, aspect: aspect as MotionSource, a11yLabel: p.alt })
  // Another photo chosen: this one goes back to fit.
  effect(() => {
    if (p.page() !== p.i) void zoom.reset({ duration: 0 })
  })
  return (
    <Column gesture={zoom} style={{ width: p.width, flex: 1 }} accessibilityLabel={p.alt} accessibilityRole="image">
      <NativeView
        name="imageviewer.page"
        props={{ uri: p.uri, held: p.held ?? "", i: p.i, scale: zoom.scale, x: zoom.x, y: zoom.y, errorText: p.errorText, retryLabel: p.retryLabel }}
        onEvent={(e) => {
          if (e.name === "loaded" && e.data?.height > 0) aspect.set(e.data.width / e.data.height)
          if (e.name === "loaded" || e.name === "error") p.onReady?.()
        }}
        style={{ flex: 1 }}
      />
    </Column>
  )
}

function label(template: string, index: number, count: number): string {
  return template.replace("{n}", String(index + 1)).replace("{count}", String(count))
}

export type { ViewerRect }

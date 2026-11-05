// A dev screen for the image viewer plugin. Log lines "image-viewer-lab ..." are for checks from adb logcat.
import { Column, Image, Pressable, Row, Scroll, Text } from "@zero-native/ui"
import { nav, onNavResult, signal } from "@zero-native/core"
import { ImageViewer, type ImageViewerResult } from "@zero-native/image-viewer"
import { Media } from "@zero-native/media"
import { c } from "./tokens"

// Store-photo sized pictures (picsum.photos, free test photos). The big one is 5000 x 3333 (picsum answers 400 above 5000 px): zoom shows the sharp parts.
const STORE = [
  "https://picsum.photos/id/1060/1200/900",
  "https://picsum.photos/id/1080/900/1200",
  "https://picsum.photos/id/292/1200/800",
  "https://picsum.photos/id/431/1000/1000",
]
const BIG = "https://picsum.photos/id/1015/5000/3333"
// Tall, like a long receipt photo: the start view fits the height, zoom in to read.
const TALL = "https://picsum.photos/id/1062/800/4000"
// JPEGs stored on their side with an EXIF turn (6: 90 degrees, 8: 270 degrees). Both must show upright, also when zoomed.
const TURNED = [
  "https://raw.githubusercontent.com/recurser/exif-orientation-examples/master/Landscape_6.jpg",
  "https://raw.githubusercontent.com/recurser/exif-orientation-examples/master/Portrait_8.jpg",
]

// A 64 x 64 red and white checker, inline (data: links are held in native memory, never in the saved params).
const DATA_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAaUlEQVR42u3XMQ0AIAxFwbrCAP5F1AgYoFMXCEcYGbjp5UeOebyrOLe9DwAAAACAFuCVj1bvAQAAAAB6ACUGAAAAsAeUGAAAAMAeUGIAAAAAe0CJAQAAAOwBJQYAAACwB5QYAAAA4BvABlkw0f8E1ZeiAAAAAElFTkSuQmCC"
// Over the 5 MB cap once decoded (7 M base64 letters = 5.25 MB): must show the error, not run out of memory.
const tooBigData = () => `data:image/png;base64,${"A".repeat(7_000_000)}`
// tools/fetch-test-server.ts answers a picture only with this header (adb reverse tcp:8788 tcp:8788).
const AUTH_IMAGE = "http://localhost:8788/image-auth"

function ViewerLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

function ViewerLabThumb(props: { src: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} style={{ borderRadius: 10, overflow: "hidden" }}>
      <Image src={props.src} loading="shimmer" style={{ width: 72, height: 72 }} />
    </Pressable>
  )
}

export function ImageViewerLabScreen() {
  console.info("image-viewer-lab open") // not at the top of the file: imports run before installRuntime()
  const status = signal("ready")
  const say = (text: string) => {
    console.info(`image-viewer-lab ${text}`)
    status.set(text)
  }
  // The answer after a kill, or from "Push (no promise)": no promise waits for it.
  onNavResult<ImageViewerResult>("imageViewer", (r, ack) => {
    say(`nav result: index ${r.index}`)
    ack()
  })

  const show = (name: string, options: Parameters<typeof ImageViewer.open>[0]) => {
    say(`${name} opened`)
    ImageViewer.open(options).then(
      (r) => say(r ? `${name} closed on ${r.index}` : `${name} closed: null`),
      (e) => say(`${name} error: ${e instanceof Error ? e.message : String(e)}`),
    )
  }

  return (
    <Scroll style={{ flex: 1, backgroundColor: c.white }}>
      <Column gap={10} style={{ padding: 16 }}>
        <Text fontSize={16}>Image viewer lab</Text>
        <Text fontSize={13}>{`status: ${status()}`}</Text>
        <Text fontSize={12}>Tap a photo: the viewer opens on it (a store's photo strip)</Text>
        <Row gap={8}>
          <ViewerLabThumb src={STORE[0]!} onPress={() => show("strip", { images: STORE, imageIndex: 0 })} />
          <ViewerLabThumb src={STORE[1]!} onPress={() => show("strip", { images: STORE, imageIndex: 1 })} />
          <ViewerLabThumb src={STORE[2]!} onPress={() => show("strip", { images: STORE, imageIndex: 2 })} />
          <ViewerLabThumb src={STORE[3]!} onPress={() => show("strip", { images: STORE, imageIndex: 3 })} />
        </Row>
        <ViewerLabButton label="One photo (no count)" onPress={() => show("one", { images: [{ uri: STORE[0]!, alt: "Shop front" }] })} />
        <ViewerLabButton label="Big photo 5000 x 3333" onPress={() => show("big", { images: [BIG] })} />
        <ViewerLabButton label="Tall photo (like a receipt)" onPress={() => show("tall", { images: [TALL] })} />
        <ViewerLabButton label="EXIF-turned photos" onPress={() => show("turned", { images: TURNED })} />
        <ViewerLabButton label="Asset picture" onPress={() => show("asset", { images: ["asset:images/offer-placeholder.png"] })} />
        <ViewerLabButton
          label="Broken, refused, then good"
          onPress={() => show("broken", { images: ["https://picsum.photos/id/99999999/400/300", "file:///sdcard/secret.jpg", STORE[0]!] })}
        />
        <ViewerLabButton label="data: picture, too big, bad" onPress={() => show("data", { images: [DATA_PNG, tooBigData(), "data:image/png;base64,%%%"] })} />
        <ViewerLabButton
          label="Header: with, then without (local server)"
          onPress={() => show("header", { images: [{ uri: AUTH_IMAGE, headers: { Authorization: "Bearer zn-lab" } }, `${AUTH_IMAGE}?no`] })}
        />
        <ViewerLabButton
          label="App file: file://, content://, other app's file"
          onPress={() => {
            say("app-file making a photo")
            // Debug builds only: a 1600 x 1200 blue JPEG in the app's cache (EXIF 90). Its content:// is the media plugin's own provider.
            Media.debugPhoto().then(
              (f) => {
                const name = f.uri.slice(f.uri.lastIndexOf("/") + 1)
                const dir = f.uri.slice(0, f.uri.lastIndexOf("/"))
                show("app-file", {
                  images: [
                    f.uri, // allowed: the app's cache
                    `content://dev.zeronative.sample.zn.media/files/${name}`, // the media plugin's own provider
                    "content://media/external/images/media/987654321", // no such picture: error
                    `${dir}/../../shared_prefs/../${name}`, // ../ out of the app's folders: refused
                  ],
                })
              },
              (e) => say(`app-file error: ${e instanceof Error ? e.message : String(e)}`),
            )
          }}
        />
        <ViewerLabButton
          label="Options: no swipe close, no double tap, Hindi words, grey"
          onPress={() =>
            show("options", {
              images: STORE,
              index: 1, // react-native-image-zoom-viewer's name
              swipeToCloseEnabled: false,
              doubleTapToZoomEnabled: false,
              backgroundColor: "#202124",
              closeLabel: "Band karein",
              errorText: "Photo load nahi hui",
              retryLabel: "Phir se try karein",
              photoLabel: "Photo {n} / {count}",
            })
          }
        />
        <ViewerLabButton label="Push (no promise, onNavResult hears it)" onPress={() => nav.push("imageViewer", { images: STORE.map((uri) => ({ uri })), index: 2 })} />
        <ViewerLabButton label="Open twice at once (one screen)" onPress={() => {
          show("twice-a", { images: STORE })
          show("twice-b", { images: STORE, imageIndex: 3 })
        }} />
        <ViewerLabButton label="Empty list (rejects)" onPress={() => show("empty", { images: [] })} />
      </Column>
    </Scroll>
  )
}

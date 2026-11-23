// The image viewer's page view on its own ("imageviewer.page", the view each photo of the TSX viewer is): one picture
// moved by motion values from buttons instead of useZoom, so the loading, the events, the zoom's move and the sharp
// part show without gestures. Log lines "image-viewer-page-lab ..." are for checks from the console.
import { Column, NativeView, Pressable, Row, Scroll, Text } from "@zeronative/ui"
import { Dimensions, signal, useMotion } from "@zeronative/core"
import { c } from "./tokens"

const PICTURES: { name: string; uri: string }[] = [
  // 5000 x 3333: at 5x the fitted copy is stretched, so the page cuts a sharp part of the original.
  { name: "big", uri: "https://picsum.photos/id/1015/5000/3333" },
  // Stored on its side with EXIF 6: upright, and its sharp part too.
  { name: "exif 6", uri: "https://raw.githubusercontent.com/recurser/exif-orientation-examples/master/Landscape_6.jpg" },
  // EXIF 2 (a mirror image): shown mirrored, no sharp part (as on Android).
  { name: "mirror", uri: "https://raw.githubusercontent.com/recurser/exif-orientation-examples/master/Landscape_2.jpg" },
  { name: "asset", uri: "asset:images/offer-placeholder.png" },
  { name: "broken", uri: "https://picsum.photos/id/99999999/400/300" },
  { name: "refused", uri: "content://media/external/images/media/1" },
]

function PageLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={12} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export function ImageViewerPageLabScreen() {
  const picture = signal(0)
  const status = signal("loading")
  const scale = useMotion(1)
  const x = useMotion(0)
  const y = useMotion(0)
  const say = (text: string) => {
    console.info(`image-viewer-page-lab ${text}`)
    status.set(text)
  }
  const zoom = (z: number, dx: number, dy: number, ms = 0) => {
    const t = ms > 0 ? { duration: ms, easing: "standard" as const } : { duration: 0 }
    void scale.to(z, t)
    void x.to(dx, t)
    void y.to(dy, t)
    say(`zoom ${z} x ${Math.round(dx)} y ${Math.round(dy)}`)
  }
  const pick = (i: number) => {
    zoom(1, 0, 0)
    picture.set(i)
    say(`picture ${PICTURES[i]!.name}`)
  }
  return (
    <Column style={{ flex: 1, backgroundColor: "#000000" }}>
      <NativeView
        name="imageviewer.page"
        props={{ uri: PICTURES[picture()]!.uri, i: 0, scale, x, y, errorText: "No photo here", retryLabel: "Again" }}
        onEvent={(e) => say(e.name === "loaded" ? `loaded ${e.data.width}x${e.data.height}` : e.name)}
        style={{ flex: 1 }}
      />
      <Scroll style={{ maxHeight: 230, backgroundColor: c.white }}>
        <Column gap={8} style={{ padding: 12 }}>
          <Text fontSize={13}>{`status: ${status()}`}</Text>
          <Row gap={6} style={{ flexWrap: "wrap" }}>
            {PICTURES.map((p, i) => (
              <PageLabButton key={p.name} label={p.name} onPress={() => pick(i)} />
            ))}
          </Row>
          <Row gap={6} style={{ flexWrap: "wrap" }}>
            <PageLabButton label="fit" onPress={() => zoom(1, 0, 0, 250)} />
            <PageLabButton label="2.5x middle" onPress={() => zoom(2.5, 0, 0, 250)} />
            <PageLabButton label="5x middle" onPress={() => zoom(5, 0, 0)} />
            {/* 5x moved so the picture's left edge meets the screen's (fitted to the width: 2 widths to the right). */}
            <PageLabButton label="5x left edge" onPress={() => zoom(5, Dimensions.get("window").width * 2, 0)} />
            <PageLabButton label="slow 1 → 4x" onPress={() => {
              zoom(1, 0, 0)
              zoom(4, -Dimensions.get("window").width, 0, 1500)
            }} />
          </Row>
        </Column>
      </Scroll>
    </Column>
  )
}

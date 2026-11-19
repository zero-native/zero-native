// A dev screen for the media plugin. The phone test (tools/plugin-phone/media.ts) reads these lines and the log lines "media-lab ...".
import { Box, Column, Image, Pressable, Scroll, Text } from "@zeronative/ui"
import { FormData, signal } from "@zeronative/core"
import { Media, type MediaFile, type MediaResult } from "@zeronative/media"
import { c } from "./tokens"

function MediaLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

const line = (f: MediaFile) => `${f.width}x${f.height} ${f.size} ${f.mime} ${f.name}`

export function MediaLabScreen() {
  console.info(`media-lab open ${typeof Media}`) // not at the top of the file: imports run before installRuntime()
  const status = signal("ready")
  const shown = signal("")
  let last: MediaFile | null = null
  const say = (text: string) => {
    console.info(`media-lab ${text}`)
    status.set(text)
  }
  const use = (word: string, f: MediaFile) => {
    last = f
    shown.set(f.handle)
    say(`${word}: ${line(f)}`)
  }
  const report = (word: string, r: MediaResult) => {
    if (r.files.length > 0) use(`${word} ${r.status} ${r.files.length}`, r.files[0]!)
    else say(`${word} ${r.status} ${r.reason ?? ""}`)
    if (r.skipped) say(`${word} skipped ${r.skipped}`)
  }
  const fail = (word: string) => (e: { code?: string }) => say(`${word} failed: ${e.code}`)
  // The answer after a kill: the promise of the pick is gone.
  Media.onResult((r, ack) => {
    report("restored", r)
    ack()
  })

  const withFile = (word: string, run: (f: MediaFile) => Promise<MediaFile>) => {
    if (last) run(last).then((f) => use(word, f), fail(word))
    else say(`${word}: no file yet`)
  }
  const exif = () => {
    if (last) Media.debugExif(last.handle).then((r) => say(`exif: turn ${r.orientation} location ${r.location}`), fail("exif"))
  }
  const upload = () => {
    const f = last
    if (!f) return say("upload: no file yet")
    const form = new FormData()
    form.append("file", { uri: f.uri, name: f.name, type: f.mime })
    // A server on the computer, through `adb reverse`: tools/plugin-phone/media.ts.
    fetch("http://127.0.0.1:8795/upload", { method: "POST", body: form as any })
      .then((r) => r.text().then((t) => say(`upload ${r.status}: ${t} sent ${f.size}`)))
      .catch((e) => say(`upload failed: ${e}`))
  }

  return (
    <Scroll style={{ flex: 1, backgroundColor: c.white }}>
      <Column gap={10} style={{ padding: 16 }}>
        <Text fontSize={16}>Media lab</Text>
        <Text fontSize={13}>{`status: ${status()}`}</Text>
        <Box style={{ height: 96 }}>{shown() !== "" && <Image src={shown()} style={{ width: 96, height: 96 }} />}</Box>
        <MediaLabButton label="Pick photo" onPress={() => Media.pickPhotos({ maxSize: 1600, quality: 80 }).then((r) => report("pick", r))} />
        <MediaLabButton label="Pick three photos" onPress={() => Media.pickPhotos({ max: 3, maxSize: 1000 }).then((r) => report("pick", r))} />
        <MediaLabButton label="Pick PDF" onPress={() => Media.pickFile({ types: ["application/pdf"] }).then((r) => report("file", r))} />
        <MediaLabButton label="Pick any file" onPress={() => Media.pickFile().then((r) => report("file", r))} />
        <MediaLabButton label="Take photo" onPress={() => Media.takePhoto({ maxSize: 1600 }).then((r) => report("take", r))} />
        <MediaLabButton label="Make test photo" onPress={() => Media.debugPhoto().then((f) => use("test photo", f), fail("test photo"))} />
        <MediaLabButton label="Compress" onPress={() => withFile("compress", (f) => Media.edit({ handle: f.handle, maxSize: 800, quality: 60 }))} />
        <MediaLabButton label="Rotate" onPress={() => withFile("rotate", (f) => Media.edit({ handle: f.handle, rotate: 90 }))} />
        <MediaLabButton label="Crop" onPress={() => withFile("crop", (f) => Media.edit({ handle: f.handle, crop: { x: 10, y: 20, width: 100, height: 50 } }))} />
        <MediaLabButton label="Bad crop" onPress={() => withFile("bad crop", (f) => Media.edit({ handle: f.handle, crop: { x: 0, y: 0, width: 99999, height: 1 } }))} />
        <MediaLabButton label="Bad handle" onPress={() => withFile("bad handle", () => Media.edit({ handle: "zn://file/../secret" }))} />
        <MediaLabButton label="Read EXIF" onPress={exif} />
        <MediaLabButton label="Upload" onPress={upload} />
        <MediaLabButton label="Clean all" onPress={() => Media.cleanup({ olderThanMs: 0 }).then((r) => say(`cleanup: ${r.deleted} files ${r.bytes} bytes`))} />
      </Column>
    </Scroll>
  )
}

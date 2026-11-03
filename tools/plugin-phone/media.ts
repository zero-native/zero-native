// Phone steps for the media plugin (examples/sample/src/MediaLab.tsx). "Make test photo" gives a 1600x1200 photo stored sideways
// with a location in it, so compress, EXIF, upload and cleanup need no hands.
import { adb, check, clearLog, expectLog, ok, openFresh, PKG, pid, shell, sleep, tap, type Step } from "./helpers"

const PORT = 8795
const lab = () => openFresh("dev/media", "Pick photo")
const CAMERA = "android.permission.CAMERA"
const focus = () => shell("dumpsys", "window", "displays").match(/mCurrentFocus=.*/)?.[0] ?? ""

async function testPhoto() {
  await lab()
  await tap("Make test photo")
  await expectLog(/media-lab test photo: 1600x1200/)
}

/**
 * Kills the app while another app is on top of it, so that app stays open. HOME would close it. Not `am kill`: Android
 * refuses it while the picker sits in our task. `run-as` (debug builds) kills the way low memory does.
 */
async function killBehind() {
  const before = pid()
  shell("run-as", PKG, "kill", "-9", before)
  await sleep(800)
  check(pid() !== before, "the process lived")
}

export const steps: Step[] = [
  {
    name: "media compress, rotation built in, no location",
    run: async () => {
      await testPhoto()
      await tap("Read EXIF")
      ok("the test photo", await expectLog(/media-lab exif: turn 90 location true/))
      await tap("Compress")
      ok("compress", await expectLog(/media-lab compress: 600x800 \d+ image\/jpeg/))
      await tap("Read EXIF")
      ok("no EXIF left", await expectLog(/media-lab exif: turn 0 location false/))
    },
  },
  {
    name: "media rotate and crop",
    run: async () => {
      await testPhoto()
      await tap("Rotate")
      ok("rotate", await expectLog(/media-lab rotate: 1600x1200/))
      await tap("Crop")
      ok("crop", await expectLog(/media-lab crop: 100x50/))
      await tap("Bad crop")
      ok("bad crop", await expectLog(/media-lab bad crop failed: invalid_crop/))
      await tap("Bad handle")
      ok("bad handle", await expectLog(/media-lab bad handle failed: not_found/))
    },
  },
  {
    name: "media upload by handle",
    run: async () => {
      let got = -1
      const server = Bun.serve({
        port: PORT,
        async fetch(req) {
          const form = await req.formData()
          got = (form.get("file") as File).size
          return new Response(String(got))
        },
      })
      adb("reverse", `tcp:${PORT}`, `tcp:${PORT}`)
      try {
        await testPhoto()
        await tap("Compress")
        const line = await expectLog(/media-lab compress: 600x800 (\d+)/)
        await tap("Upload")
        const sent = await expectLog(/media-lab upload 200: (\d+) sent (\d+)/)
        const [, a, b] = /upload 200: (\d+) sent (\d+)/.exec(sent)!
        check(a === b && Number(a) === got, `the server got ${a}, the file has ${b}`)
        ok("upload", `${sent} (${line})`)
      } finally {
        adb("reverse", "--remove", `tcp:${PORT}`)
        void server.stop(true)
      }
    },
  },
  {
    name: "media cleanup",
    run: async () => {
      await testPhoto()
      await tap("Clean all")
      ok("cleanup", await expectLog(/media-lab cleanup: [1-9]\d* files/))
      await tap("Compress")
      ok("old handle", await expectLog(/media-lab compress failed: not_found/))
    },
  },
  {
    name: "media pick back gives cancelled",
    run: async () => {
      await lab()
      await tap("Pick photo")
      await sleep(1500)
      shell("input", "keyevent", "KEYCODE_BACK")
      ok("cancelled", await expectLog(/media-lab pick cancelled/))
      await tap("Pick photo")
      await sleep(1500)
      shell("input", "keyevent", "KEYCODE_BACK")
      ok("a second pick is not blocked", await expectLog(/media-lab pick cancelled/))
    },
  },
  {
    name: "media take with no camera permission",
    run: async () => {
      // The sample has the scanner plugin, so CAMERA is in its manifest, and the camera app can't open without it.
      shell("pm", "revoke", PKG, CAMERA)
      try {
        await lab()
        await tap("Take photo")
        await tap(/^(Don.t allow|Deny)$/i)
        ok("refused, no crash", await expectLog(/media-lab take failed camera_(denied|blocked)/))
      } finally {
        shell("pm", "clear-permission-flags", PKG, CAMERA, "user-fixed", "user-set")
        shell("pm", "grant", PKG, CAMERA)
      }
    },
  },
  {
    name: "media pick photo",
    hands: "The photo picker opens on the phone. Tap one photo.",
    run: async () => {
      await lab()
      await tap("Pick photo")
      ok("pick", await expectLog(/media-lab pick ok 1: \d+x\d+ \d+ image\/jpeg/, 60000))
      await tap("Read EXIF")
      ok("no location", await expectLog(/media-lab exif: turn 0 location false/))
    },
  },
  {
    name: "media pick three photos",
    hands: "The picker opens. Tap three photos, then the Add button.",
    run: async () => {
      await lab()
      await tap("Pick three photos")
      ok("three", await expectLog(/media-lab pick ok 3: /, 90000))
    },
  },
  {
    name: "media pick PDF",
    hands: "The file picker opens. Tap a PDF. Any PDF will do; if there is none, press Back and this step fails, which is fine.",
    run: async () => {
      await lab()
      await tap("Pick PDF")
      ok("PDF", await expectLog(/media-lab file ok 1: 0x0 \d+ application\/pdf/, 60000))
    },
  },
  {
    name: "media take photo",
    hands: "The camera app opens. Take a photo and accept it.",
    run: async () => {
      await lab()
      await tap("Take photo")
      ok("take", await expectLog(/media-lab take ok 1: \d+x\d+ \d+ image\/jpeg/, 60000))
      await tap("Read EXIF")
      ok("no location", await expectLog(/media-lab exif: turn 0 location false/))
    },
  },
  {
    // The photo picker doesn't cover our screen fully, so the app stays visible: Android never kills it for memory there, and
    // never saves its screen. A forced kill (run-as) only removes the screen, like a crash ("app died, no saved state", seen
    // 2026-11-03). So the check is that Android refuses the kill. The camera app covers us fully: "media kill during take".
    name: "media no kill while the picker is open",
    run: async () => {
      await lab()
      await tap("Pick photo")
      await sleep(2500)
      check(focus().includes("photopicker") || focus().includes("documentsui"), `the picker isn't on top: ${focus()}`)
      const before = pid()
      shell("am", "kill", PKG)
      await sleep(800)
      check(pid() === before, "Android killed the app under the picker")
      ok("kept alive", "am kill refused while the picker is open")
      clearLog()
      shell("input", "keyevent", "KEYCODE_BACK")
      ok("back gives cancelled", await expectLog(/media-lab pick cancelled/, 10000))
    },
  },
  {
    name: "media kill during take",
    hands: "The camera app opens, and the script kills the app behind it. Wait for the words KILLED, then take a photo and accept it.",
    run: async () => {
      await lab()
      await tap("Take photo")
      await sleep(2500)
      await killBehind()
      clearLog()
      console.log("KILLED: take the photo now")
      ok("a photo survives a kill", await expectLog(/media-lab restored ok 1: \d+x\d+/, 60000))
    },
  },
]

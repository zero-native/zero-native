// A dev screen for <Canvas> (registry 23, docs/components.md §14). Each tile says what you should see.
// Tiles draw their own background (c.white), so they look the same in light and dark mode.
import { Box, Canvas, Column, Pressable, Row, Scroll, Stack, Text } from "@zero-native/ui"
import { draw, type CanvasCommand, onCleanup, setInterval, signal, smoothPath, useMotion, usePan } from "@zero-native/core"
import { c } from "./tokens"

// Lab colours (the tokens have no chart colours).
const UP = "#16A34A"
const DOWN = "#DC2626"
const ACCENT = "#8B5CF6"

interface Candle {
  open: number
  close: number
  high: number
  low: number
}

function generateInitialCandles(count: number): Candle[] {
  let price = 100
  const candles: Candle[] = []
  for (let i = 0; i < count; i++) {
    const delta = (Math.random() - 0.49) * 4
    const open = price
    const close = price + delta
    const high = Math.max(open, close) + Math.random() * 2
    const low = Math.min(open, close) - Math.random() * 2
    candles.push({ open, close, high, low })
    price = close
  }
  return candles
}

function Tile(props: { title: string; expect: string; children?: unknown }) {
  return (
    <Column style={{ gap: 6 }}>
      <Text fontSize={15} fontWeight={600} color={c.ink}>
        {props.title}
      </Text>
      <Text fontSize={12} color={c.muted}>
        {`You should see: ${props.expect}`}
      </Text>
      {props.children}
    </Column>
  )
}

// A smooth-ish series for the area chart.
const AREA = [42, 48, 45, 60, 58, 72, 66, 80, 76, 90, 84, 96]

// Chart scrub: 24 prices (₹) and where each point is drawn (dp), worked out once.
const SCRUB_W = 340
const SCRUB_H = 160
const SCRUB_PAD = 16
const PRICES = [4210, 4235, 4228, 4262, 4290, 4275, 4301, 4344, 4320, 4388, 4410, 4395, 4372, 4420, 4466, 4440, 4485, 4512, 4498, 4530, 4575, 4551, 4590, 4620]
const PRICE_MIN = Math.min(...PRICES)
const PRICE_MAX = Math.max(...PRICES)
const SCRUB_XS = PRICES.map((_, i) => SCRUB_PAD + (i * (SCRUB_W - SCRUB_PAD * 2)) / (PRICES.length - 1))
const SCRUB_YS = PRICES.map((p) => SCRUB_H - SCRUB_PAD - ((p - PRICE_MIN) / (PRICE_MAX - PRICE_MIN)) * (SCRUB_H - SCRUB_PAD * 2))

// A tick in a circle, for the path trim tile (dp).
const TICK = "M 38 62 L 54 78 L 84 44"
const RING = "M 60 16 A 44 44 0 1 1 59.99 16"

const LONG_TEXT =
  "ZeroBill keeps every bill you pay in one place. Scan the QR at the counter, pay with any UPI app, and the bill lands here with its cashback. No paper, no lost receipts, no waiting at the counter."

function CanvasButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.pillBg, borderRadius: 6 }}>
      <Text fontSize={12} fontWeight={600} color={c.ink}>
        {props.label}
      </Text>
    </Pressable>
  )
}

// 9. A line chart you scrub with a finger: the cursor, the dot and the ₹ price all follow pan.touchX natively.
function ChartScrubTile() {
  const pan = usePan({ axis: "x" })
  // Clamped to the chart (map clamps by default); the dot's y and the price come from the chart's own arrays.
  const cx = pan.touchX.map([SCRUB_PAD, SCRUB_W - SCRUB_PAD], [SCRUB_PAD, SCRUB_W - SCRUB_PAD])
  const cy = pan.touchX.map(SCRUB_XS, SCRUB_YS)
  const price = pan.touchX.map(SCRUB_XS, PRICES)
  const points = SCRUB_XS.map((x, i) => [x, SCRUB_YS[i]] as [number, number])
  const commands = (): CanvasCommand[] => [
    draw.rect(0, 0, SCRUB_W, SCRUB_H, { color: c.white }),
    draw.line(SCRUB_PAD, SCRUB_H - SCRUB_PAD, SCRUB_W - SCRUB_PAD, SCRUB_H - SCRUB_PAD, { color: c.border, strokeWidth: 1 }),
    draw.polyline(points, { style: "stroke", strokeWidth: 2, strokeJoin: "round", color: UP }),
    draw.line(cx, SCRUB_PAD / 2, cx, SCRUB_H - SCRUB_PAD, { color: c.muted, strokeWidth: 1, dash: [4, 4] }),
    draw.circle(cx, cy, 9, { color: "rgba(22, 163, 74, 0.25)" }),
    draw.circle(cx, cy, 5, { color: UP }),
    draw.circle(cx, cy, 5, { style: "stroke", strokeWidth: 2, color: c.white }),
  ]
  return (
    <Tile
      title="9. Chart scrub (motion values in commands)"
      expect="drag sideways on the chart: a dashed line and a green dot follow your finger along the line, and the ₹ price above changes with it, smoothly, with no JS per frame. Before the first touch the cursor sits on the first point."
    >
      <Text fontSize={22} fontWeight={700} color={c.ink}>
        {price.format({ prefix: "₹", decimals: 2 })}
      </Text>
      <Box style={{ width: SCRUB_W, height: SCRUB_H, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
        <Canvas gesture={pan} style={{ width: SCRUB_W, height: SCRUB_H }} commands={commands()} accessibilityLabel="Price, last 24 days, going up" />
      </Box>
    </Tile>
  )
}

// 10. A progress ring whose sweep is a motion value: the buttons move it natively; the % is v.format in a <Text>.
function MotionRingTile() {
  const progress = useMotion(65)
  let target = 65
  const go = (to: number) => {
    target = Math.max(0, Math.min(100, to))
    progress.to(target, { duration: 600, easing: "standard" })
  }
  const sweep = progress.map([0, 100], [0, 360])
  const commands = (): CanvasCommand[] => [
    draw.circle(80, 80, 60, { style: "stroke", strokeWidth: 14, color: c.border }),
    draw.arc(20, 20, 120, 120, -90, sweep, false, { style: "stroke", strokeWidth: 14, strokeCap: "round", color: c.primary }),
  ]
  return (
    <Tile title="10. Progress ring from a motion value" expect="tap the buttons: the ring grows or shrinks smoothly from 12 o'clock, and the % in the middle counts with it.">
      <Row gap={8} alignItems="center">
        <CanvasButton label="0%" onPress={() => go(0)} />
        <CanvasButton label="-25%" onPress={() => go(target - 25)} />
        <CanvasButton label="+25%" onPress={() => go(target + 25)} />
        <CanvasButton label="100%" onPress={() => go(100)} />
      </Row>
      <Stack style={{ width: 160, height: 160, alignSelf: "center" }}>
        <Canvas style={{ width: 160, height: 160 }} commands={commands()} />
        <Box style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, alignItems: "center", justifyContent: "center" }}>
          <Text fontSize={24} fontWeight={700} color={c.ink}>
            {progress.format({ suffix: "%" })}
          </Text>
        </Box>
      </Stack>
    </Tile>
  )
}

// 11. Path trim: a tick in a circle drawn by trimEnd (a motion value), like an "order placed" mark.
function PathTrimTile() {
  const t = useMotion(0)
  let on = false
  const commands = (): CanvasCommand[] => [
    draw.rect(0, 0, 120, 120, { color: c.white }),
    draw.path(RING, { style: "stroke", strokeWidth: 6, strokeCap: "round", color: c.success }, { trimEnd: t.map([0, 0.6], [0, 1]) }),
    draw.path(TICK, { style: "stroke", strokeWidth: 8, strokeCap: "round", strokeJoin: "round", color: c.success }, { trimEnd: t.map([0.6, 1], [0, 1]) }),
  ]
  return (
    <Tile title="11. Path trim" expect="tap Draw: a green circle draws itself, then the tick inside it. Tap again: it goes back the same way.">
      <Row gap={8}>
        <CanvasButton
          label="Draw"
          onPress={() => {
            on = !on
            t.to(on ? 1 : 0, { duration: 900, easing: "standard" })
          }}
        />
      </Row>
      <Box style={{ width: 120, height: 120, alignSelf: "center" }}>
        <Canvas style={{ width: 120, height: 120 }} commands={commands()} />
      </Box>
    </Tile>
  )
}

export function CanvasLabScreen() {
  const candles = signal<Candle[]>(generateInitialCandles(200))
  const progress = signal(65)
  const autoPlay = signal(true)

  // 500 ms live feed updates
  const timer = setInterval(() => {
    if (!autoPlay()) return
    candles.set((prev) => {
      const last = prev[prev.length - 1]
      const delta = (Math.random() - 0.48) * 3
      const nextOpen = last.close
      const nextClose = nextOpen + delta
      const nextHigh = Math.max(nextOpen, nextClose) + Math.random() * 2
      const nextLow = Math.min(nextOpen, nextClose) - Math.random() * 2
      return [...prev.slice(1), { open: nextOpen, close: nextClose, high: nextHigh, low: nextLow }]
    })
  }, 500)
  onCleanup(() => clearInterval(timer))

  // Candlestick commands
  const candleCommands = (): CanvasCommand[] => {
    const list = candles()
    const cmds: CanvasCommand[] = []
    const width = 340
    const height = 180
    const padding = 10
    const drawH = height - padding * 2

    let minPrice = Infinity
    let maxPrice = -Infinity
    for (const k of list) {
      if (k.low < minPrice) minPrice = k.low
      if (k.high > maxPrice) maxPrice = k.high
    }
    const range = Math.max(maxPrice - minPrice, 1)
    const toY = (val: number) => padding + drawH - ((val - minPrice) / range) * drawH
    const candleW = (width - padding * 2) / list.length

    // Background and a dashed middle line
    cmds.push(draw.rect(0, 0, width, height, { color: c.white, style: "fill" }))
    cmds.push(draw.line(padding, toY(minPrice + range * 0.5), width - padding, toY(minPrice + range * 0.5), {
      color: c.border,
      strokeWidth: 1,
      dash: [4, 4],
    }))

    for (let i = 0; i < list.length; i++) {
      const k = list[i]
      const color = k.close >= k.open ? UP : DOWN
      const x = padding + i * candleW
      const cx = x + candleW / 2
      const top = Math.min(toY(k.open), toY(k.close))
      const bot = Math.max(toY(k.open), toY(k.close))

      // Wick
      cmds.push(draw.line(cx, toY(k.high), cx, toY(k.low), { color, strokeWidth: 1 }))
      // Body
      cmds.push(draw.rect(x + 0.2, top, Math.max(candleW - 0.4, 1), Math.max(bot - top, 1), { color, style: "fill" }))
    }
    return cmds
  }

  // Progress ring commands
  const ringCommands = (): CanvasCommand[] => {
    const p = progress()
    const size = 160
    const cx = size / 2
    const cy = size / 2
    const r = 60
    const strokeW = 14
    const sweep = (p / 100) * 360

    return [
      draw.circle(cx, cy, r, { style: "stroke", strokeWidth: strokeW, color: c.border }),
      // -90: start at 12 o'clock (0 is 3 o'clock), going clockwise.
      draw.arc(cx - r, cy - r, r * 2, r * 2, -90, sweep, false, {
        style: "stroke",
        strokeWidth: strokeW,
        strokeCap: "round",
        color: c.primary,
      }),
      // y is the baseline: +8 puts a 24 dp number roughly in the middle.
      draw.text(`${Math.round(p)}%`, cx, cy + 8, { fontSize: 24, fontWeight: "bold", color: c.ink, align: "center" }),
    ]
  }

  // Dashed path commands
  const pathCommands = (): CanvasCommand[] => [
    draw.rect(0, 0, 340, 100, { color: c.white, style: "fill" }),
    draw.path("M 20 50 Q 80 10, 140 50 T 260 50 T 320 50", {
      style: "stroke",
      strokeWidth: 3,
      strokeCap: "round",
      color: ACCENT,
      dash: [8, 6],
    }),
    draw.circle(20, 50, 4, { color: ACCENT, style: "fill" }),
    draw.circle(140, 50, 4, { color: ACCENT, style: "fill" }),
    draw.circle(260, 50, 4, { color: ACCENT, style: "fill" }),
    draw.circle(320, 50, 4, { color: ACCENT, style: "fill" }),
  ]

  // Rotated text compass commands
  const rotatedTextCommands = (): CanvasCommand[] => {
    const size = 180
    const cx = size / 2
    const cy = size / 2
    const cmds: CanvasCommand[] = [
      draw.circle(cx, cy, 88, { color: c.white, style: "fill" }),
      draw.circle(cx, cy, 75, { style: "stroke", strokeWidth: 1, color: c.disabled, dash: [3, 3] }),
      draw.circle(cx, cy, 3, { color: c.muted, style: "fill" }),
    ]
    const angles = [
      { deg: 0, label: "N" },
      { deg: 45, label: "NE" },
      { deg: 90, label: "E" },
      { deg: 135, label: "SE" },
      { deg: 180, label: "S" },
      { deg: 225, label: "SW" },
      { deg: 270, label: "W" },
      { deg: 315, label: "NW" },
    ]
    for (const a of angles) {
      cmds.push(draw.save())
      cmds.push(draw.translate(cx, cy))
      cmds.push(draw.rotate(a.deg))
      cmds.push(
        draw.text(a.label, 0, -56, {
          fontSize: 11,
          fontWeight: a.label.length === 1 ? "bold" : "normal",
          color: a.label === "N" ? DOWN : c.ink,
          align: "center",
        }),
      )
      cmds.push(draw.restore())
    }
    return cmds
  }

  // Area chart: a path filled with a linear gradient (top: primary, bottom: transparent), and its line on top.
  const areaCommands = (): CanvasCommand[] => {
    const w = 340
    const h = 140
    const pad = 12
    const step = (w - pad * 2) / (AREA.length - 1)
    const toY = (v: number) => h - pad - (v / 100) * (h - pad * 2)
    // A smooth curve that never overshoots (core smoothPath): it never goes above the highest point.
    const line = smoothPath(AREA.map((v, i) => [pad + i * step, toY(v)] as [number, number]))
    const area = `${line} L ${w - pad} ${h - pad} L ${pad} ${h - pad} Z`
    return [
      draw.rect(0, 0, w, h, { color: c.white }),
      draw.path(area, { linearGradient: { x0: 0, y0: pad, x1: 0, y1: h - pad, colors: ["rgba(61, 38, 237, 0.45)", "rgba(61, 38, 237, 0)"] } }),
      draw.path(line, { style: "stroke", strokeWidth: 2, strokeJoin: "round", color: c.primary }),
    ]
  }

  // clipRect and scale: a big circle cut by a clip, and a small square drawn twice as big.
  const clipScaleCommands = (): CanvasCommand[] => [
    draw.rect(0, 0, 340, 120, { color: c.white }),
    draw.save(),
    draw.clipRect(20, 20, 120, 80),
    // r 50 at (80, 60): wider than the 80 dp tall clip, so its top and bottom are cut flat; its sides stay round.
    draw.circle(80, 60, 50, { color: c.primary }),
    draw.restore(),
    draw.rect(20, 20, 120, 80, { style: "stroke", strokeWidth: 1, color: c.border }),
    draw.save(),
    draw.translate(200, 20),
    draw.scale(2),
    draw.roundRect(0, 0, 40, 40, 6, { color: c.success }),
    draw.restore(),
    // No save around this translate: it must not move the tile's border or anything after it (save / restoreToCount).
    draw.translate(1000, 1000),
  ]

  // oval and roundRect, with a radial gradient on the oval.
  const shapeCommands = (): CanvasCommand[] => [
    draw.rect(0, 0, 340, 100, { color: c.white }),
    draw.oval(20, 20, 140, 60, { radialGradient: { cx: 90, cy: 50, r: 70, colors: [ACCENT, c.white] } }),
    draw.roundRect(180, 20, 140, 60, 16, { color: c.successBg }),
    draw.roundRect(180, 20, 140, 60, 16, { style: "stroke", strokeWidth: 2, color: c.success }),
  ]

  // Bad commands: each one is wrong on purpose. The app must not crash; the good parts draw; logcat (tag zn) has one
  // warning that names the bad indexes. No red dev screen: the rest of the canvas is fine (second-opinions 197).
  const badCommands = (): CanvasCommand[] => [
    draw.rect(0, 0, 340, 80, { color: c.white }),
    // 1: a gradient with one colour: drawn solid in that colour.
    draw.rect(20, 20, 80, 40, { linearGradient: { x0: 0, y0: 0, x1: 80, y1: 0, colors: [UP] } }),
    // 2: dash with one value: drawn without a dash.
    draw.line(120, 40, 200, 40, { style: "stroke", strokeWidth: 3, color: c.primary, dash: [4] }),
    // 3: NaN: skipped.
    draw.circle(NaN, 40, 10, { color: DOWN }),
    // 4: a restore without a save: skipped.
    draw.restore(),
    // 5: still drawn.
    draw.circle(260, 40, 16, { color: UP }),
  ]

  // 12. Images: an asset with cover and a radius, the same with contain, a photo from the web, and a broken URL.
  const imageCommands = (): CanvasCommand[] => [
    draw.rect(0, 0, 340, 110, { color: c.white }),
    draw.image("asset:images/offer-placeholder.png", 10, 10, 100, 90, { fit: "cover", radius: 12 }),
    draw.rect(120, 10, 100, 90, { color: c.pillBg }),
    draw.image("asset:images/offer-placeholder.png", 120, 10, 100, 90, { fit: "contain" }),
    draw.image("https://picsum.photos/id/292/400/360", 230, 10, 100, 90, { fit: "cover", radius: 45, opacity: 0.9 }),
    // Broken on purpose: draws nothing, with a warning in logcat.
    draw.image("https://zeronative.dev/nonexistent_canvas_404.png", 0, 0, 40, 40),
  ]

  // 13. Paragraphs: wrapped text cut at 3 lines with "…", and a centred one.
  const paragraphCommands = (): CanvasCommand[] => [
    draw.rect(0, 0, 340, 150, { color: c.white }),
    draw.paragraph(LONG_TEXT, 16, 12, 308, { fontSize: 14, lineHeight: 20, maxLines: 3, color: c.ink }),
    draw.line(16, 80, 324, 80, { color: c.border, strokeWidth: 1 }),
    draw.paragraph("Paid ₹499 to Sharma Stores", 16, 92, 308, { fontSize: 16, fontWeight: "bold", align: "center", color: c.success }),
    draw.paragraph("Today, 4:32 PM · UPI", 16, 118, 308, { fontSize: 12, align: "center", color: c.muted }),
  ]

  // 14. A QR scanner frame: a dark cover with a rounded hole (clipRoundRect "difference"), a white border and corners.
  const scannerCommands = (): CanvasCommand[] => {
    const cmds: CanvasCommand[] = []
    // Stand-in for the camera picture: coloured stripes.
    const stripes = [UP, c.primary, ACCENT, DOWN, "#F59E0B", "#0EA5E9"]
    for (let i = 0; i < 12; i++) cmds.push(draw.rect(i * 30, 0, 30, 220, { color: stripes[i % stripes.length] }))
    const x = 90
    const y = 30
    const s = 160
    cmds.push(
      draw.save(),
      draw.clipRoundRect(x, y, s, s, 20, { op: "difference" }),
      draw.rect(0, 0, 340, 220, { color: "rgba(0, 0, 0, 0.65)" }),
      draw.restore(),
      draw.roundRect(x, y, s, s, 20, { style: "stroke", strokeWidth: 2, color: "rgba(255, 255, 255, 0.6)" }),
    )
    // Corner marks, as one path with round ends.
    const k = 28
    const corners =
      `M ${x} ${y + k} L ${x} ${y} L ${x + k} ${y} M ${x + s - k} ${y} L ${x + s} ${y} L ${x + s} ${y + k} ` +
      `M ${x + s} ${y + s - k} L ${x + s} ${y + s} L ${x + s - k} ${y + s} M ${x + k} ${y + s} L ${x} ${y + s} L ${x} ${y + s - k}`
    cmds.push(draw.path(corners, { style: "stroke", strokeWidth: 5, strokeCap: "round", strokeJoin: "round", color: c.white }))
    cmds.push(draw.paragraph("Point at the shop's QR", 0, 198, 340, { fontSize: 13, align: "center", color: c.white }))
    return cmds
  }

  // 15. Paint effects: a sweep gradient ring, multiply, a shadow, a blur glow, and an even-odd donut.
  const effectsCommands = (): CanvasCommand[] => [
    draw.rect(0, 0, 340, 130, { color: c.white }),
    draw.circle(55, 65, 38, {
      style: "stroke",
      strokeWidth: 14,
      sweepGradient: { cx: 55, cy: 65, colors: [c.primary, ACCENT, UP, c.primary], startAngle: -90 },
    }),
    draw.circle(130, 55, 24, { color: "#F87171" }),
    draw.circle(150, 75, 24, { color: "#60A5FA", blendMode: "multiply" }),
    draw.roundRect(195, 35, 60, 60, 12, { color: c.white, shadow: { dx: 0, dy: 4, blur: 10, color: "rgba(15, 23, 42, 0.35)" } }),
    draw.circle(300, 45, 18, { color: ACCENT, blur: 10 }),
    draw.circle(300, 45, 8, { color: c.white }),
    draw.path("M 280 80 h 40 v 40 h -40 Z M 290 90 h 20 v 20 h -20 Z", { color: c.ink, fillType: "evenOdd" }),
  ]

  return (
    <Scroll style={{ flex: 1, backgroundColor: c.bg }}>
      <Column gap={16} style={{ padding: 16, paddingBottom: 48 }}>
        <Text fontSize={18} fontWeight={700} color={c.ink}>
          Canvas Lab (H4)
        </Text>
        <Text fontSize={13} color={c.muted}>
          2D drawing from a command list, in the draw phase only. A bad command never crashes the app.
        </Text>

        <Tile title="1. Candlestick chart, 200 points" expect="green and red candles that move left every 500 ms, and a dashed middle line.">
          <Row gap={8}>
            <Pressable
              onPress={() => autoPlay.set(!autoPlay())}
              style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.primary, borderRadius: 6 }}
            >
              <Text fontSize={12} fontWeight={600} color={c.white}>
                {autoPlay() ? "Pause Ticks" : "Resume Ticks"}
              </Text>
            </Pressable>
          </Row>
          <Box style={{ width: 340, height: 180, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
            <Canvas style={{ width: 340, height: 180 }} commands={candleCommands()} accessibilityLabel="Price chart, last 200 ticks" />
          </Box>
        </Tile>

        <Tile title="2. Progress ring" expect="a ring that starts at 12 o'clock and grows clockwise, with the % in the middle.">
          <Row gap={8} alignItems="center">
            <Pressable
              onPress={() => progress.set(Math.max(0, progress() - 10))}
              style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.pillBg, borderRadius: 6 }}
            >
              <Text fontSize={12} fontWeight={600} color={c.ink}>-10%</Text>
            </Pressable>
            <Pressable
              onPress={() => progress.set(Math.min(100, progress() + 10))}
              style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.pillBg, borderRadius: 6 }}
            >
              <Text fontSize={12} fontWeight={600} color={c.ink}>+10%</Text>
            </Pressable>
            <Text fontSize={13} color={c.ink}>
              Progress: {progress()}%
            </Text>
          </Row>
          <Box style={{ width: 160, height: 160, alignSelf: "center" }}>
            <Canvas style={{ width: 160, height: 160 }} commands={ringCommands()} accessibilityLabel={`Progress ${progress()} percent`} />
          </Box>
        </Tile>

        <Tile title="3. Dashed wave path" expect="a purple dashed wave through 4 dots.">
          <Box style={{ width: 340, height: 100, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
            <Canvas style={{ width: 340, height: 100 }} commands={pathCommands()} />
          </Box>
        </Tile>

        <Tile title="4. Text in rotated groups" expect="a compass with 8 labels around it; N is red and bold.">
          <Box style={{ width: 180, height: 180, alignSelf: "center" }}>
            <Canvas style={{ width: 180, height: 180 }} commands={rotatedTextCommands()} />
          </Box>
        </Tile>

        <Tile title="5. Area chart with a gradient" expect="a blue line; under it a fill that fades from blue at the top to clear at the bottom (same on every phone).">
          <Box style={{ width: 340, height: 140, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
            <Canvas style={{ width: 340, height: 140 }} commands={areaCommands()} accessibilityLabel="Sales, last 12 months, going up" />
          </Box>
        </Tile>

        <Tile title="6. clipRect and scale" expect="left: a blue circle with its top and bottom cut flat by the grey box (its round sides show); right: a green rounded square, 80 dp. The grey border of this tile stays in place.">
          <Box style={{ width: 340, height: 120, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
            <Canvas style={{ width: 340, height: 120 }} commands={clipScaleCommands()} />
          </Box>
        </Tile>

        <Tile title="7. oval and roundRect" expect="left: an oval, purple in the middle fading to white; right: a light green rounded box with a green border.">
          <Box style={{ width: 340, height: 100, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
            <Canvas style={{ width: 340, height: 100 }} commands={shapeCommands()} />
          </Box>
        </Tile>

        <Tile title="8. Bad commands" expect="a green box, a solid blue line (no dash) and a green dot. No crash and no red screen. Logcat (tag zn): one warning naming commands 1-4.">
          <Box style={{ width: 340, height: 80, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
            <Canvas style={{ width: 340, height: 80 }} commands={badCommands()} />
          </Box>
        </Tile>

        <ChartScrubTile />
        <MotionRingTile />
        <PathTrimTile />

        <Tile title="12. Images" expect="left: the offer picture filling a rounded box (cut to fit); middle: the whole picture on a grey box; right: a photo from the web in a circle (needs internet). Nothing at the top-left corner: that URL is broken on purpose (a warning in logcat).">
          <Box style={{ width: 340, height: 110, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
            <Canvas style={{ width: 340, height: 110 }} commands={imageCommands()} />
          </Box>
        </Tile>

        <Tile title="13. Paragraphs" expect="3 lines of wrapped text, the third ending with …; under a line, a green bold centred title and a grey centred time.">
          <Box style={{ width: 340, height: 150, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
            <Canvas style={{ width: 340, height: 150 }} commands={paragraphCommands()} />
          </Box>
        </Tile>

        <Tile title="14. Scanner frame (clip difference)" expect="coloured stripes, dark everywhere except a bright rounded square in the middle with white corner marks, and white text at the bottom.">
          <Box style={{ width: 340, height: 220, borderRadius: 8, overflow: "hidden" }}>
            <Canvas style={{ width: 340, height: 220 }} commands={scannerCommands()} />
          </Box>
        </Tile>

        <Tile title="15. Paint effects" expect="left to right: a ring that fades blue → purple → green from 12 o'clock; a red and a blue circle whose overlap is dark purple (multiply); a white card with a soft shadow (Android 9+); a soft purple glow with a white dot (blur, Android 9+); a black square with a square hole (evenOdd).">
          <Box style={{ width: 340, height: 130, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
            <Canvas style={{ width: 340, height: 130 }} commands={effectsCommands()} />
          </Box>
        </Tile>
      </Column>
    </Scroll>
  )
}

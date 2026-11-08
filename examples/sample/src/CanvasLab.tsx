// A dev screen for <Canvas> (registry 23, docs/components.md §14). Each tile says what you should see.
// Tiles draw their own background (c.white), so they look the same in light and dark mode.
import { Box, Canvas, Column, Pressable, Row, Scroll, Text } from "@zero-native/ui"
import { draw, type CanvasCommand, onCleanup, setInterval, signal } from "@zero-native/core"
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
    let line = ""
    for (let i = 0; i < AREA.length; i++) line += `${i === 0 ? "M" : "L"} ${pad + i * step} ${toY(AREA[i])} `
    const area = `${line}L ${w - pad} ${h - pad} L ${pad} ${h - pad} Z`
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
    draw.circle(80, 60, 70, { color: c.primary }),
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

  // Bad commands: each one is wrong on purpose. The app must not crash; the good parts draw; a debug build shows one
  // dev error that names the bad indexes.
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

        <Tile title="6. clipRect and scale" expect="left: a blue circle cut to a box; right: a green rounded square, 80 dp. The grey border of this tile stays in place.">
          <Box style={{ width: 340, height: 120, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
            <Canvas style={{ width: 340, height: 120 }} commands={clipScaleCommands()} />
          </Box>
        </Tile>

        <Tile title="7. oval and roundRect" expect="left: an oval, purple in the middle fading to white; right: a light green rounded box with a green border.">
          <Box style={{ width: 340, height: 100, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
            <Canvas style={{ width: 340, height: 100 }} commands={shapeCommands()} />
          </Box>
        </Tile>

        <Tile title="8. Bad commands" expect="a green box, a solid blue line (no dash) and a green dot. No crash. In a debug build: one dev error naming commands 1-4.">
          <Box style={{ width: 340, height: 80, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
            <Canvas style={{ width: 340, height: 80 }} commands={badCommands()} />
          </Box>
        </Tile>
      </Column>
    </Scroll>
  )
}

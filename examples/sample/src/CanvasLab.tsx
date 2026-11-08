import { Box, Canvas, Column, Pressable, Row, Scroll, Text } from "@zero-native/ui"
import { draw, type CanvasCommand, onCleanup, setInterval, signal } from "@zero-native/core"
import { c } from "./tokens"

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
    for (const c of list) {
      if (c.low < minPrice) minPrice = c.low
      if (c.high > maxPrice) maxPrice = c.high
    }
    const range = Math.max(maxPrice - minPrice, 1)
    const toY = (val: number) => padding + drawH - ((val - minPrice) / range) * drawH
    const candleW = (width - padding * 2) / list.length

    // Background grid lines
    cmds.push(draw.rect(0, 0, width, height, { color: "#F8FAFC", style: "fill" }))
    cmds.push(draw.line(padding, toY(minPrice + range * 0.5), width - padding, toY(minPrice + range * 0.5), {
      color: "#E2E8F0",
      strokeWidth: 1,
      dash: [4, 4],
    }))

    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      const isUp = c.close >= c.open
      const color = isUp ? "#16A34A" : "#DC2626"
      const x = padding + i * candleW
      const cx = x + candleW / 2
      const yHigh = toY(c.high)
      const yLow = toY(c.low)
      const yOpen = toY(c.open)
      const yClose = toY(c.close)
      const top = Math.min(yOpen, yClose)
      const bot = Math.max(yOpen, yClose)

      // Wick
      cmds.push(draw.line(cx, yHigh, cx, yLow, { color, strokeWidth: 1 }))
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
      draw.circle(cx, cy, r, {
        style: "stroke",
        strokeWidth: strokeW,
        color: "#E5E7EB",
      }),
      draw.arc(cx - r, cy - r, r * 2, r * 2, -90, sweep, false, {
        style: "stroke",
        strokeWidth: strokeW,
        strokeCap: "round",
        color: "#3B82F6",
      }),
      draw.text(`${Math.round(p)}%`, cx, cy + 8, {
        fontSize: 24,
        fontWeight: "bold",
        color: "#1E293B",
        align: "center",
      }),
    ]
  }

  // Dashed path commands
  const pathCommands = (): CanvasCommand[] => {
    return [
      draw.rect(0, 0, 340, 100, { color: "#FAF5FF", style: "fill" }),
      draw.path("M 20 50 Q 80 10, 140 50 T 260 50 T 320 50", {
        style: "stroke",
        strokeWidth: 3,
        strokeCap: "round",
        color: "#8B5CF6",
        dash: [8, 6],
      }),
      draw.circle(20, 50, 4, { color: "#8B5CF6", style: "fill" }),
      draw.circle(140, 50, 4, { color: "#8B5CF6", style: "fill" }),
      draw.circle(260, 50, 4, { color: "#8B5CF6", style: "fill" }),
      draw.circle(320, 50, 4, { color: "#8B5CF6", style: "fill" }),
    ]
  }

  // Rotated text compass commands
  const rotatedTextCommands = (): CanvasCommand[] => {
    const size = 180
    const cx = size / 2
    const cy = size / 2
    const cmds: CanvasCommand[] = [
      draw.circle(cx, cy, 75, { style: "stroke", strokeWidth: 1, color: "#CBD5E1", dash: [3, 3] }),
      draw.circle(cx, cy, 3, { color: "#64748B", style: "fill" }),
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
          color: a.label === "N" ? "#EF4444" : "#475569",
          align: "center",
        }),
      )
      cmds.push(draw.restore())
    }
    return cmds
  }

  return (
    <Scroll style={{ flex: 1, backgroundColor: c.bg }}>
      <Column gap={16} style={{ padding: 16, paddingBottom: 48 }}>
        <Text fontSize={18} fontWeight={700} color={c.ink}>
          Canvas Primitive Lab (H4)
        </Text>
        <Text fontSize={13} color={c.muted}>
          2D drawing without Skia via JSON slot transport in the draw phase only.
        </Text>

        {/* 1. Candlestick Chart */}
        <Text fontSize={15} fontWeight={600} color={c.ink}>
          1. 200-Point Candlestick Chart (500 ms ticks)
        </Text>
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
        <Box style={{ width: 340, height: 180, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: "#E2E8F0" }}>
          <Canvas style={{ width: 340, height: 180 }} commands={candleCommands()} />
        </Box>

        {/* 2. Donut Progress Ring */}
        <Text fontSize={15} fontWeight={600} color={c.ink}>
          2. Donut Progress Ring
        </Text>
        <Row gap={8} alignItems="center">
          <Pressable
            onPress={() => progress.set(Math.max(0, progress() - 10))}
            style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "#E5E7EB", borderRadius: 6 }}
          >
            <Text fontSize={12} fontWeight={600} color={c.ink}>-10%</Text>
          </Pressable>
          <Pressable
            onPress={() => progress.set(Math.min(100, progress() + 10))}
            style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "#E5E7EB", borderRadius: 6 }}
          >
            <Text fontSize={12} fontWeight={600} color={c.ink}>+10%</Text>
          </Pressable>
          <Text fontSize={13} color={c.ink}>
            Progress: {progress()}%
          </Text>
        </Row>
        <Box style={{ width: 160, height: 160, alignSelf: "center" }}>
          <Canvas style={{ width: 160, height: 160 }} commands={ringCommands()} />
        </Box>

        {/* 3. Dashed Path */}
        <Text fontSize={15} fontWeight={600} color={c.ink}>
          3. Dashed Bezier Wave Path
        </Text>
        <Box style={{ width: 340, height: 100, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: "#E2E8F0" }}>
          <Canvas style={{ width: 340, height: 100 }} commands={pathCommands()} />
        </Box>

        {/* 4. Rotated Text Groups */}
        <Text fontSize={15} fontWeight={600} color={c.ink}>
          4. Text in Rotated Compass Groups
        </Text>
        <Box style={{ width: 180, height: 180, alignSelf: "center" }}>
          <Canvas style={{ width: 180, height: 180 }} commands={rotatedTextCommands()} />
        </Box>
      </Column>
    </Scroll>
  )
}

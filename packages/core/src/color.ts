// Colours are parsed at build time into ARGB numbers, so native never parses colour strings (v0 parsed "#hex"
// on every draw). Accepted (same as React Native): "#RGB", "#RGBA", "#RRGGBB", "#RRGGBBAA", "rgb(r, g, b)",
// "rgba(r, g, b, a)" (a from 0 to 1, or a percentage), "transparent".
export function parseColor(input: string): number {
  const s = input.trim().toLowerCase()
  if (s === "transparent") return 0
  const fn = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)(%?)\s*)?\)$/.exec(s)
  if (fn) {
    const [r, g, b] = [fn[1], fn[2], fn[3]].map(Number)
    const alpha = fn[4] === undefined ? 1 : Number(fn[4]) / (fn[5] ? 100 : 1)
    if (r > 255 || g > 255 || b > 255 || alpha > 1) throw new Error(`invalid colour "${input}" (channels 0–255, alpha 0–1)`)
    const a = Math.round(alpha * 255)
    return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0
  }
  const m = /^#([0-9a-f]{3,8})$/.exec(s)
  if (!m || ![3, 4, 6, 8].includes(m[1].length)) {
    throw new Error(`invalid colour "${input}" (use #RGB, #RGBA, #RRGGBB, #RRGGBBAA, rgb(), rgba() or "transparent")`)
  }
  let hex = m[1]
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("")
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255
  return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0
}

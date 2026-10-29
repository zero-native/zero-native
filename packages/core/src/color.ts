// Colours are parsed at build time into ARGB numbers, so native never parses colour strings (v0 parsed "#hex"
// on every draw). Accepted (same as React Native): "#RGB", "#RGBA", "#RRGGBB", "#RRGGBBAA", "transparent".
export function parseColor(input: string): number {
  const s = input.trim().toLowerCase()
  if (s === "transparent") return 0
  const m = /^#([0-9a-f]{3,8})$/.exec(s)
  if (!m || ![3, 4, 6, 8].includes(m[1].length)) {
    throw new Error(`invalid colour "${input}" (use #RGB, #RGBA, #RRGGBB, #RRGGBBAA or "transparent")`)
  }
  let hex = m[1]
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("")
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255
  return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0
}

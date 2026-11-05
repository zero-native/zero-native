// Colours are parsed at build time into ARGB numbers, so native never parses colour strings (v0 parsed "#hex"
// on every draw). Accepted (same as React Native): "#RGB", "#RGBA", "#RRGGBB", "#RRGGBBAA", "rgb(r, g, b)",
// "rgba(r, g, b, a)" (a from 0 to 1, or a percentage), "transparent", and since 2026-11-05 (RN-compat sweep P1.3)
// the 148 CSS colour names ("white", "red", "rebeccapurple") and "hsl(h, s%, l%)" / "hsla(h, s%, l%, a)".
// A colour that changes at runtime is parsed here too (view.ts), so these work there as well.

/** CSS colour names → 0xRRGGBB, as React Native accepts them. Built on first use. */
let named: Map<string, number> | null = null
const NAMED =
  "aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black " +
  "000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 " +
  "chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff " +
  "darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki " +
  "bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon " +
  "e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 " +
  "darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick " +
  "b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 " +
  "goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 " +
  "indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 " +
  "lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray " +
  "d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue " +
  "87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 " +
  "limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd " +
  "mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a " +
  "mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin " +
  "ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered " +
  "ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip " +
  "ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 " +
  "red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 " +
  "seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 " +
  "snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise " +
  "40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32"

export function parseColor(input: string): number {
  const s = input.trim().toLowerCase()
  if (s === "transparent") return 0
  if (/^[a-z]+$/.test(s)) {
    if (!named) {
      named = new Map()
      const words = NAMED.split(" ")
      for (let i = 0; i < words.length; i += 2) named.set(words[i], parseInt(words[i + 1], 16))
    }
    const rgb = named.get(s)
    if (rgb !== undefined) return (0xff000000 | rgb) >>> 0
  }
  const hsl = /^hsla?\(\s*(-?\d*\.?\d+)(?:deg)?\s*,\s*(\d*\.?\d+)%\s*,\s*(\d*\.?\d+)%\s*(?:,\s*(\d*\.?\d+)(%?)\s*)?\)$/.exec(s)
  if (hsl) {
    const h = (((Number(hsl[1]) % 360) + 360) % 360) / 360
    const sat = Number(hsl[2]) / 100
    const light = Number(hsl[3]) / 100
    const alpha = hsl[4] === undefined ? 1 : Number(hsl[4]) / (hsl[5] ? 100 : 1)
    if (sat > 1 || light > 1 || alpha > 1) throw new Error(`invalid colour "${input}" (saturation and lightness 0–100%, alpha 0–1)`)
    // CSS Color 4's hsl → rgb.
    const f = (n: number) => {
      const k = (n + h * 12) % 12
      const a = sat * Math.min(light, 1 - light)
      return Math.round(255 * (light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
    }
    return ((Math.round(alpha * 255) << 24) | (f(0) << 16) | (f(8) << 8) | f(4)) >>> 0
  }
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
    throw new Error(`invalid colour "${input}" (use #RGB, #RGBA, #RRGGBB, #RRGGBBAA, rgb(), rgba(), hsl(), hsla(), a CSS colour name or "transparent")`)
  }
  let hex = m[1]
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("")
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255
  return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0
}

export interface CanvasLinearGradient {
  x0: number
  y0: number
  x1: number
  y1: number
  colors: string[]
  stops?: number[]
}

export interface CanvasRadialGradient {
  cx: number
  cy: number
  r: number
  colors: string[]
  stops?: number[]
}

export interface CanvasPaint {
  color?: string
  style?: "fill" | "stroke"
  strokeWidth?: number
  strokeCap?: "butt" | "round" | "square"
  strokeJoin?: "miter" | "round" | "bevel"
  dash?: number[]
  opacity?: number
  linearGradient?: CanvasLinearGradient
  radialGradient?: CanvasRadialGradient
}

export interface CanvasTextOptions {
  fontSize?: number
  fontWeight?: number | "normal" | "bold"
  color?: string
  align?: "left" | "center" | "right"
}

export type CanvasCommand =
  | { type: "rect"; x: number; y: number; w: number; h: number; paint?: CanvasPaint }
  | { type: "roundRect"; x: number; y: number; w: number; h: number; r: number; paint?: CanvasPaint }
  | { type: "circle"; cx: number; cy: number; r: number; paint?: CanvasPaint }
  | { type: "oval"; x: number; y: number; w: number; h: number; paint?: CanvasPaint }
  | { type: "line"; x1: number; y1: number; x2: number; y2: number; paint?: CanvasPaint }
  | { type: "arc"; x: number; y: number; w: number; h: number; start: number; sweep: number; useCenter?: boolean; paint?: CanvasPaint }
  | { type: "path"; d: string; paint?: CanvasPaint }
  | { type: "text"; text: string; x: number; y: number; options?: CanvasTextOptions }
  | { type: "save" }
  | { type: "restore" }
  | { type: "translate"; dx: number; dy: number }
  | { type: "scale"; sx: number; sy?: number }
  | { type: "rotate"; degrees: number; px?: number; py?: number }
  | { type: "clipRect"; x: number; y: number; w: number; h: number }

export const draw = {
  rect(x: number, y: number, w: number, h: number, paint?: CanvasPaint): CanvasCommand {
    return { type: "rect", x, y, w, h, paint }
  },
  roundRect(x: number, y: number, w: number, h: number, r: number, paint?: CanvasPaint): CanvasCommand {
    return { type: "roundRect", x, y, w, h, r, paint }
  },
  circle(cx: number, cy: number, r: number, paint?: CanvasPaint): CanvasCommand {
    return { type: "circle", cx, cy, r, paint }
  },
  oval(x: number, y: number, w: number, h: number, paint?: CanvasPaint): CanvasCommand {
    return { type: "oval", x, y, w, h, paint }
  },
  line(x1: number, y1: number, x2: number, y2: number, paint?: CanvasPaint): CanvasCommand {
    return { type: "line", x1, y1, x2, y2, paint }
  },
  arc(x: number, y: number, w: number, h: number, start: number, sweep: number, useCenter = false, paint?: CanvasPaint): CanvasCommand {
    return { type: "arc", x, y, w, h, start, sweep, useCenter, paint }
  },
  path(d: string, paint?: CanvasPaint): CanvasCommand {
    return { type: "path", d, paint }
  },
  text(text: string, x: number, y: number, options?: CanvasTextOptions): CanvasCommand {
    return { type: "text", text, x, y, options }
  },
  save(): CanvasCommand {
    return { type: "save" }
  },
  restore(): CanvasCommand {
    return { type: "restore" }
  },
  translate(dx: number, dy: number): CanvasCommand {
    return { type: "translate", dx, dy }
  },
  scale(sx: number, sy = sx): CanvasCommand {
    return { type: "scale", sx, sy }
  },
  rotate(degrees: number, px = 0, py = 0): CanvasCommand {
    return { type: "rotate", degrees, px, py }
  },
  clipRect(x: number, y: number, w: number, h: number): CanvasCommand {
    return { type: "clipRect", x, y, w, h }
  },
}

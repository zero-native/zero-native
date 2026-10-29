// console → native log (Android: logcat tag "zn-js").
const LEVELS = { debug: 0, log: 1, info: 1, warn: 2, error: 3 } as const

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(" ")
}

export function installConsole(): void {
  const console: Record<string, (...args: unknown[]) => void> = {}
  for (const [name, level] of Object.entries(LEVELS)) {
    console[name] = (...args: unknown[]) => globalThis.__zn_log(level, format(args))
  }
  ;(globalThis as any).console = console
}

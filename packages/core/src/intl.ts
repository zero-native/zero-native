// Fast `toLocaleString` (step 3.9). `Number.prototype.toLocaleString` and the three `Date.prototype.toLocale*String`
// methods build a new Intl formatter on every call: ~2 ms each on the Lava, against ~0.004 ms for a formatter that is
// reused (docs/guide-notes.md §25). These versions keep the formatters they make, per locale and options, so
// `amount.toLocaleString("en-IN")` in a list row is fast without the author doing anything.
//
// The result is the same text: the JS standard defines these methods as "make a formatter with these options (plus
// the method's defaults) and format". Anything unusual (an invalid date, bad options) goes to the original method,
// which gives the same answer or the same error as before.

/** The methods as they were before installIntlCache (for tests and the dev check screen). */
export const intlOriginals = {
  number: Number.prototype.toLocaleString,
  date: Date.prototype.toLocaleString,
  dateOnly: Date.prototype.toLocaleDateString,
  timeOnly: Date.prototype.toLocaleTimeString,
}

const MAX_FORMATTERS = 64
const DATE_FIELDS = ["weekday", "year", "month", "day"]
const TIME_FIELDS = ["dayPeriod", "hour", "minute", "second", "fractionalSecondDigits"]

type Options = Record<string, unknown> | undefined

/** The standard's ToDateTimeOptions: which defaults a Date method adds when no field of its kind is given. */
function dateOptions(options: Options, required: "any" | "date" | "time", defaults: "all" | "date" | "time"): Options {
  const o: Record<string, unknown> = { ...(options ?? {}) }
  if (o.dateStyle !== undefined || o.timeStyle !== undefined) return o
  const has = (fields: string[]) => fields.some((f) => o[f] !== undefined)
  let needDefaults = true
  if ((required === "date" || required === "any") && has(DATE_FIELDS)) needDefaults = false
  if ((required === "time" || required === "any") && has(TIME_FIELDS)) needDefaults = false
  if (needDefaults && (defaults === "date" || defaults === "all")) o.year = o.month = o.day = "numeric"
  if (needDefaults && (defaults === "time" || defaults === "all")) o.hour = o.minute = o.second = "numeric"
  return o
}

export function installIntlCache(): void {
  if (typeof Intl === "undefined" || typeof Intl.NumberFormat !== "function") return
  const cache = new Map<string, { format(v: number | Date): string }>()
  const formatter = (kind: string, locales: unknown, options: Options, make: () => { format(v: number | Date): string }) => {
    const key = `${kind}\u0000${JSON.stringify(locales ?? null)}\u0000${JSON.stringify(options ?? null)}`
    let f = cache.get(key)
    if (!f) {
      if (cache.size >= MAX_FORMATTERS) cache.delete(cache.keys().next().value!) // the oldest one
      f = make()
      cache.set(key, f)
    }
    return f
  }

  Number.prototype.toLocaleString = function (this: number, locales?: string | string[], options?: Intl.NumberFormatOptions) {
    const value = Number(this)
    try {
      return formatter("n", locales, options as Options, () => new Intl.NumberFormat(locales, options)).format(value)
    } catch {
      return intlOriginals.number.call(this, locales, options)
    }
  }

  const dateMethod = (
    original: (this: Date, l?: string | string[], o?: Intl.DateTimeFormatOptions) => string,
    required: "any" | "date" | "time",
    defaults: "all" | "date" | "time",
  ) =>
    function (this: Date, locales?: string | string[], options?: Intl.DateTimeFormatOptions): string {
      if (!(this instanceof Date) || Number.isNaN(this.getTime())) return original.call(this, locales, options)
      // A date-only method given only a time style (or the reverse) is an error in the standard: let the original say so.
      if (required === "date" && options?.timeStyle !== undefined) return original.call(this, locales, options)
      if (required === "time" && options?.dateStyle !== undefined) return original.call(this, locales, options)
      try {
        const o = dateOptions(options as Options, required, defaults)
        return formatter(`d${required}`, locales, o, () => new Intl.DateTimeFormat(locales, o as Intl.DateTimeFormatOptions)).format(this)
      } catch {
        return original.call(this, locales, options)
      }
    }
  Date.prototype.toLocaleString = dateMethod(intlOriginals.date, "any", "all")
  Date.prototype.toLocaleDateString = dateMethod(intlOriginals.dateOnly, "date", "date")
  Date.prototype.toLocaleTimeString = dateMethod(intlOriginals.timeOnly, "time", "time")
}

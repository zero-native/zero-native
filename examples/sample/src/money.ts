// Amount rules of the ZeroBill checkout (docs/flow_checkout.md §5 in the RN repo). Money is in paise (integers).

export interface Session {
  merchant: string
  maxCashbackPaise: number
  minTotalForCashbackPaise: number
  platformFeePaise: number
}

const MAX_INTEGER_DIGITS = 7
const MAX_DECIMALS = 2

/** Applies a keypad key ("0"–"9" or ".") to the typed amount string. */
export function applyKey(prev: string, key: string): string {
  const [int, dec] = prev.split(".")
  if (key === ".") return prev.includes(".") ? prev : `${prev}.`
  if (dec !== undefined) return dec.length >= MAX_DECIMALS ? prev : prev + key
  if (int === "0") return key
  return int.length >= MAX_INTEGER_DIGITS ? prev : prev + key
}

export function backspace(prev: string): string {
  return prev.length <= 1 ? "0" : prev.slice(0, -1)
}

/** "1250.5" → 125050 paise, without floating-point maths. */
export function toPaise(amount: string): number {
  const [int, dec = ""] = amount.split(".")
  return Number(int || "0") * 100 + Number((dec + "00").slice(0, 2))
}

/** Indian grouping for the typed amount: "1234567.5" → "12,34,567.5" (keeps what the user typed after the dot). */
export function formatIndian(amount: string): string {
  const [int, dec] = amount.split(".")
  const last3 = int.slice(-3)
  const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")
  const grouped = rest ? `${rest},${last3}` : last3
  return dec === undefined ? grouped : `${grouped}.${dec}`
}

/** Paise → rupees text with up to 2 decimals and no trailing zeros: 5000 → "50", 1250 → "12.5". */
export function rupees(paise: number): string {
  const whole = Math.floor(paise / 100)
  const frac = paise % 100
  if (frac === 0) return String(whole)
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`
}

/** Cashback, platform fee and the amount to pay (same rules as the RN app). */
export function financials(amountPaise: number, s: Session) {
  const cashback =
    s.maxCashbackPaise === 0 || amountPaise <= s.maxCashbackPaise || amountPaise < s.minTotalForCashbackPaise
      ? 0
      : s.maxCashbackPaise
  const fee = cashback > 0 ? s.platformFeePaise : 0
  return { cashback, fee, toPay: Math.max(0, amountPaise - cashback + fee) }
}

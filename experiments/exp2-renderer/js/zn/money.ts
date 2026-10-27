/**
 * Zero-Native Money and Financial Calculations
 * 1:1 Parity with ZeroBill production rules (paise integer precision).
 */

export interface SessionData {
  max_cashback?: number;
  min_total_to_use_cashback?: number;
  platform_fee?: number;
  locked_total_amount?: number;
  merchant?: {
    name: string;
    zmc?: string;
    counters?: number;
  };
}

export interface Financials {
  cashback: number;
  fee: number;
  toPay: number;
}

/**
 * Format string with Indian grouping system (lakhs/crores): 1,23,456.50
 */
export function formatIndianDisplay(raw: string): string {
  if (!raw || raw === "0") return "0";
  const parts = raw.split(".");
  const intStr = parts[0] || "0";

  let lastThree = intStr.substring(intStr.length - 3);
  const otherNumbers = intStr.substring(0, intStr.length - 3);
  if (otherNumbers !== "") {
    lastThree = "," + lastThree;
  }
  const formattedInt = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + lastThree;

  if (parts.length > 1) {
    return `${formattedInt}.${parts[1]}`;
  }
  return formattedInt;
}

/**
 * Convert rupee amount string (e.g. "1250.50") to integer paise (125050)
 */
export function parseToPaise(raw: string): number {
  if (!raw || raw === "0") return 0;
  const parts = raw.split(".");
  const rupees = parseInt(parts[0], 10) || 0;
  let paise = 0;
  if (parts.length > 1) {
    const decStr = (parts[1] + "00").substring(0, 2);
    paise = parseInt(decStr, 10) || 0;
  }
  return rupees * 100 + paise;
}

/**
 * Convert integer paise to formatted rupee string with 2 decimals
 */
export function paiseToRupees(paise: number): number {
  return paise / 100;
}

/**
 * Exact cashback & platform fee calculation per ZeroBill rules
 */
export function calculateFinancials(amountRupees: number, session: SessionData | null): Financials {
  if (!session) {
    return { cashback: 0, fee: 0, toPay: amountRupees };
  }

  const maxCashback = session.max_cashback || 0;
  const minTotal = session.min_total_to_use_cashback || 0;
  const platformFee = session.platform_fee || 0;

  let cashback = 0;
  if (maxCashback > 0 && amountRupees > maxCashback && amountRupees >= minTotal) {
    cashback = maxCashback;
  }

  const fee = cashback > 0 && platformFee > 0 ? platformFee : 0;
  const toPay = Math.max(0, amountRupees - cashback + fee);

  return { cashback, fee, toPay };
}

/**
 * Keypad string state updater applying production constraints:
 * - max 7 integer digits
 * - max 2 decimals
 * - single decimal point
 */
export function applyKeypadInput(currentStr: string, key: string): string {
  if (key === ".") {
    if (currentStr.includes(".")) return currentStr;
    if (currentStr === "0" || currentStr === "") return "0.";
    return currentStr + ".";
  }

  if (currentStr.includes(".")) {
    const parts = currentStr.split(".");
    if (parts[1] && parts[1].length >= 2) return currentStr; // max 2 decimals
  } else {
    if (currentStr.length >= 7) return currentStr; // max 7 integer digits
  }

  if (currentStr === "0") {
    return key;
  }
  return currentStr + key;
}

/**
 * Keypad backspace state updater
 */
export function applyBackspace(currentStr: string): string {
  if (currentStr.length <= 1) {
    return "0";
  }
  return currentStr.slice(0, -1);
}

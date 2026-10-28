/**
 * UPI intent result interpretation.
 * Line-for-line port of Flutter's UPIHandlerUtils.understandResponse
 * (my-flutter-app/lib/utils/upi_handler_utils.dart).
 *
 * The backend (`/transactions/verify` → payments API `verify-upi-payment`) parses `upi_response` with
 * URLSearchParams and decides cancel/fail from resultCode / Status / responseCode / AppID, so the merged
 * `KEY=VALUE&...` string produced here must stay byte-compatible with what Flutter sends.
 *
 * Kept free of react-native imports so it can be unit-tested in isolation.
 */

export type UpiPaymentStatus = 'VERIFY' | 'FAILED' | 'CANCELLED';

export interface UpiIntentResponse {
  status: UpiPaymentStatus;
  message: string;
  /** Merged upper-cased `KEY=VALUE&...` string sent to the backend as `upi_response`. */
  response: string | null;
}

function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return true;
  }
  return false;
}

/** Dart `Uri.decodeComponent` / `Uri.decodeQueryComponent` semantics (throws where Dart throws). */
function dartUriDecode(s: string, plusToSpace: boolean): string {
  const simple = !hasNonAscii(s) && !s.includes('%') && !(plusToSpace && s.includes('+'));
  if (simple) return s;
  if (hasNonAscii(s)) throw new Error('Illegal percent encoding in URI');
  return decodeURIComponent(plusToSpace ? s.replace(/\+/g, ' ') : s);
}

/** Dart `Uri.splitQueryString`: later duplicates overwrite, keys starting with '=' are skipped. */
function dartSplitQueryString(query: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const element of query.split('&')) {
    const index = element.indexOf('=');
    if (index === -1) {
      if (element !== '') map.set(dartUriDecode(element, true), '');
    } else if (index !== 0) {
      map.set(dartUriDecode(element.substring(0, index), true), dartUriDecode(element.substring(index + 1), true));
    }
  }
  return map;
}

/** Dart `Object.toString()` for the values we can receive from the native bridge. */
function dartToString(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (Array.isArray(value)) return `[${value.map(dartToString).join(', ')}]`;
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `${k}: ${dartToString(v)}`).join(', ')}}`;
  }
  return String(value);
}

/** Dart `ensureIntOrNull`. */
function ensureIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  const s = String(value);
  return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : null;
}

/** Dart `ensureStringOrNull`. */
function ensureStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return dartToString(value);
}

/** Splits `a=b&c=d` without decoding (Flutter's fallback when decoding throws). */
function manualSplit(raw: string, put: (k: string, v: string) => void): void {
  for (const pair of raw.split('&')) {
    if (pair.includes('=')) {
      const parts = pair.split('=');
      put(parts[0].toUpperCase(), parts.slice(1).join('='));
    }
  }
}

/**
 * Parses the raw result of a UPI intent (native event map, cached map, or query string).
 *
 * Native Android returns a map with `resultCode` (0 = RESULT_CANCELED, -1 = RESULT_OK), the intent
 * extras (Status, txnId, responseCode, ApprovalRefNo, ...) and optionally `response`, a raw query
 * string from the UPI app. Everything is merged into one upper-cased key map.
 */
export function understandUpiResponse(event: unknown): UpiIntentResponse {
  if (event === null || event === undefined) {
    return { status: 'CANCELLED', message: 'No response from UPI app', response: null };
  }

  try {
    let resultCode: number | null = null;
    let explicitStatus: string | null = null;
    const responseKeyMap = new Map<string, string>();

    if (typeof event === 'object' && !Array.isArray(event)) {
      const map = event as Record<string, unknown>;
      resultCode = ensureIntOrNull(map.resultCode);
      explicitStatus =
        ensureStringOrNull(map.Status) ?? ensureStringOrNull(map.STATUS) ?? ensureStringOrNull(map.status);

      // All top-level intent extras (excluding the nested 'response')
      for (const [key, value] of Object.entries(map)) {
        if (key !== 'response' && value !== null && value !== undefined) {
          responseKeyMap.set(key.toUpperCase(), dartToString(value));
        }
      }

      // The nested 'response' query string can carry extra (or duplicate) data; merge if absent
      const nested = map.response;
      const putIfAbsent = (k: string, v: string) => {
        if (!responseKeyMap.has(k)) responseKeyMap.set(k, v);
      };
      if (nested !== null && nested !== undefined && dartToString(nested) !== '') {
        if (typeof nested === 'object' && !Array.isArray(nested)) {
          for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
            putIfAbsent(k.toUpperCase(), dartToString(v));
          }
        } else if (typeof nested === 'string') {
          try {
            const decoded = dartUriDecode(nested, false);
            for (const [k, v] of dartSplitQueryString(decoded)) putIfAbsent(k.toUpperCase(), v);
          } catch {
            manualSplit(nested, putIfAbsent);
          }
        }
      }
    } else if (typeof event === 'string') {
      if (event !== '' && event !== 'null') {
        try {
          const decoded = dartUriDecode(event, false);
          for (const [k, v] of dartSplitQueryString(decoded)) responseKeyMap.set(k.toUpperCase(), v);
        } catch {
          manualSplit(event, (k, v) => responseKeyMap.set(k, v));
        }
      }
    }

    // Merged querystring for the backend
    const responseString =
      responseKeyMap.size > 0
        ? Array.from(responseKeyMap.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('&')
        : dartToString(event);

    const finalStatus = (explicitStatus ?? responseKeyMap.get('STATUS') ?? responseKeyMap.get('STATUS_CODE') ?? '')
      .toUpperCase()
      .trim();
    const responseCode = (
      responseKeyMap.get('RESPONSECODE') ??
      responseKeyMap.get('RESPONSE_CODE') ??
      responseKeyMap.get('RES_CODE') ??
      ''
    )
      .toUpperCase()
      .trim();
    const approvalRefNo = (
      responseKeyMap.get('APPROVALREFNO') ??
      responseKeyMap.get('APPROVAL_REF_NO') ??
      responseKeyMap.get('RRN') ??
      responseKeyMap.get('REFNO') ??
      ''
    ).trim();
    const txnId = (responseKeyMap.get('TXNID') ?? responseKeyMap.get('TXN_ID') ?? '').trim();

    // 1. NPCI responseCode (highest fidelity): 02 / U69 / ZD = user cancelled, 00 / 0 = success
    if (responseCode === '02' || responseCode === 'U69' || responseCode === 'ZD') {
      return {
        status: 'CANCELLED',
        message: `Cancelled from UPI app (responseCode: ${responseCode})`,
        response: responseString,
      };
    }
    if (responseCode === '00' || responseCode === '0') {
      return { status: 'VERIFY', message: `Success (responseCode: ${responseCode})`, response: responseString };
    }

    // 2. Explicit failure / cancellation statuses
    switch (finalStatus) {
      case 'USER_DROPPED':
      case 'CANCELLED':
      case 'CANCELED':
      case 'DECLINED':
        return { status: 'CANCELLED', message: 'Cancelled from UPI app', response: responseString };
      case 'FAILED':
      case 'FAILURE':
      case 'FAIL':
        return { status: 'FAILED', message: 'Failed', response: responseString };
      case 'SUCCESS':
        return { status: 'VERIFY', message: 'Success', response: responseString };
    }

    // 3. Bank RRN present -> funds were authorised / debited
    if (approvalRefNo !== '' && approvalRefNo !== 'null') {
      return { status: 'VERIFY', message: `Approval ref found: ${approvalRefNo}`, response: responseString };
    }

    // 4. In-flight statuses: Back pressed (resultCode 0) with no bank txnId means aborted
    const isSubmittingOrPending =
      finalStatus === 'SUBMITTED' ||
      finalStatus === 'PENDING' ||
      finalStatus === 'DEEMED' ||
      finalStatus === 'IN-PROGRESS' ||
      finalStatus === 'IN_PROGRESS';
    if (isSubmittingOrPending) {
      const hasValidTxnId = txnId !== '' && txnId !== 'null';
      if (resultCode === 0 && !hasValidTxnId) {
        return { status: 'CANCELLED', message: 'Cancelled from UPI app', response: responseString };
      }
      return { status: 'VERIFY', message: `In-flight: ${finalStatus}`, response: responseString };
    }

    // 5. Fallback on the Android Activity resultCode
    if (resultCode === 0) {
      return { status: 'CANCELLED', message: 'Cancelled from UPI app', response: responseString };
    }

    return { status: 'VERIFY', message: '', response: responseString };
  } catch {
    return { status: 'FAILED', message: 'Unable to parse application response', response: dartToString(event) };
  }
}

/** Value sent as `upi_response` (Flutter: `response.response ?? event.toString()`). */
export function upiResponseForBackend(parsed: UpiIntentResponse, event: unknown): string {
  return parsed.response ?? dartToString(event);
}

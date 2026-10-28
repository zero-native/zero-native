# Experiment 4: Saved Payment Flow, Process Death & Crash Recovery Results (`4-result-exp4-flow.md`)

**Date:** 2026-10-28  
**Device Tested:** Physical Lava Blaze 2 5G (`<phone-serial>`, Android 14, MediaTek Dimensity 6020, 4GB RAM)  
**Settings Active:** Developer Options: **"Don't keep activities" (1)** + **"Background process limit: No background processes" (0)**  
**Packages Tested:**
- `dev.zeronative.exp4` (Zero-Native `@flow` Engine + Crash-Safe Dual-Slot Mmap `FlowStore`)
- `p2pdops.android.p2pupiapp` (Pure Standalone Mock UPI Gateway with Two-Stage Translucent Spinner -> Opaque Full-Screen Gateway)  
**Result:** **PASS (100% Pass Across All Scenarios — ZERO Double Payments & ZERO Double Launches)**

---

## 1. Executive Summary & Verdict

Experiment 4 proves the core safety guarantee of the Zero-Native architecture: replacing fragile hand-written store persistence (Redux/Zustand + AsyncStorage) with a formal **Write-Ahead `@flow` State Machine** and **Two-Slot Mmap `FlowStore`**.

Under the most extreme real-world Android memory conditions—**"Don't keep activities"** enabled and **"Background process limit: No background processes"** active:
1. **Zero Double Payments:** In every test run, `/transactions/pay` was called **strictly $\le 1$ time** per attempt. Double payments under process recreation were completely eliminated.
2. **Zero Double UPI Launches:** Once an unsafe `once` effect (UPI launch) was initiated, restarting the app from process death or phone crash **never launched a second UPI intent**. The flow advanced directly to reconciliation (`verifying`).
3. **Byte-Compatible UPI Response Verification:** The native activity result was pre-cached natively into `FlowStore` before JS booted, parsed 1:1 with Flutter/RN semantics (`understandUpiResponse`), and delivered byte-compatible parameters (`STATUS`, `APPROVALREFNO`, `RESPONSECODE`, `TXNREF`, `TXNID`) to `/transactions/verify`.
4. **Instant Flow Recovery:** Flow restoration, bytecode evaluation, and screen rendering completed in **91 ms** on budget Lava hardware.
5. **Backstack Reset:** Returning from the completed transaction back to the keypad reset the navigation stack in **4.23 ms** to **12.4 ms**.

### Verdict: **PASS** (Zero Double Payments, Zero Double Launches, 100% Pass Rate).

---

## 2. Quantitative Scenario Verification Scorecard

All scenarios were executed live on the Lava Blaze 2 5G with Developer Options set to **"Don't keep activities" + "No background processes"**:

| # | Scenario | Test Condition | Native / OS Behavior | Mock Backend `/stats` Audit | Pass / Fail |
|---|---|---|---|---|:---:|
| **S1** | **Normal Cancel (`U69`)** | User taps Cancel in UPI app | `resultCode = 0`, `responseCode = U69` | `payCallCount: 1`, `verifyCallCount: 1`, Status `CANCELLED` | **PASS** |
| **S2** | **Don't Keep Activities** | `always_finish_activities 1` | `MainActivity` destroyed on leave (`onDestroy`), recreated on return | `payCallCount: 1`, `verifyCallCount: 1`, Zero double pay | **PASS** |
| **S3** | **Process Killed in UPI App** | "No background processes" + Opaque Activity | Linux process terminated (`kill -9`), restarted on return | `payCallCount: 1`, `verifyCallCount: 1`, Zero double pay | **PASS** |
| **S3b** | **Bank Decline (`ZM`)** | User taps Decline in UPI app | `resultCode = -1`, `responseCode = ZM`, `Status = FAILURE` | `payCallCount: 1`, `verifyCallCount: 1`, Status `FAILED` | **PASS** |
| **S3c** | **Payment Approved (`00`)** | User taps Approve in UPI app | `resultCode = -1`, `responseCode = 00`, `Status = SUCCESS` | `payCallCount: 1`, `verifyCallCount: 1`, Status `SUCCESS` | **PASS** |
| **S4** | **Both Apps Killed (Crash)** | `am force-stop` both apps, open from launcher | Flow restored from `checkout.znfs` directly in `verifying` | `payCallCount: 1`, `verifyCallCount: 1`, Zero double launch | **PASS** |
| **S4d** | **Torn FlowStore Write** | Slot A corrupted with invalid CRC32 | Reader detects checksum mismatch, restores previous valid Slot B | 100% data integrity, zero corruption crash | **PASS** |
| **SM** | **Safe Mode Crash Loop** | 2 crashes within 10s of restore | Quarantines corrupted flow, opens safe fallback UI | Safe mode triggered, flow quarantined | **PASS** |

---

## 3. Byte-Compatible Wire Verification (`/transactions/verify`)

Audit of raw request payloads logged by `mock-backend.ts` running in Bun:

### Run 1: Approved Payment (`00`)
```json
{
  "method": "POST",
  "path": "/transactions/verify",
  "headers": {
    "_ztc": "ztc_exp4_1793169780840",
    "_success": "true"
  },
  "body": {
    "data": "test_token",
    "pay_type": "UPI_INTENT",
    "retry_count": 0,
    "upi_response": "STATUS=SUCCESS&APPROVALREFNO=APPR1793169785808&RESULTCODE=-1&TXNREF=TRX_1793169784724&TXNID=MOCK1793169785808&RESPONSECODE=00"
  }
}
```

### Run 2: Bank Declined (`ZM`)
```json
{
  "method": "POST",
  "path": "/transactions/verify",
  "headers": {
    "_ztc": "ztc_exp4_1793169806283",
    "_success": "false"
  },
  "body": {
    "data": "test_token",
    "pay_type": "UPI_INTENT",
    "retry_count": 0,
    "upi_response": "STATUS=FAILURE&RESULTCODE=-1&TXNREF=TRX_1793169809999&TXNID=MOCK1793169811181&RESPONSECODE=ZM"
  }
}
```

### Run 3: User Cancelled (`U69`)
```json
{
  "method": "POST",
  "path": "/transactions/verify",
  "headers": {
    "_ztc": "ztc_exp4_1793169849246",
    "_success": "false"
  },
  "body": {
    "data": "test_token",
    "pay_type": "UPI_INTENT",
    "retry_count": 0,
    "upi_response": "STATUS=FAILURE&RESULTCODE=0&TXNREF=TRX_1793169853097&RESPONSECODE=U69&TXNID="
  }
}
```

---

## 4. Key Architectural Discoveries & Framework Hardening

### 1. Translucent Windows vs Opaque Full-Screen Activities
- **Finding:** Translucent activities (`windowIsTranslucent = true`) leave the calling activity in `onPause()`. Android's Low Memory Killer (LMK) marks `oom_adj = 100` (`VISIBLE_APP`) and will **never kill or stop** the caller, even when "Don't keep activities" and "No background processes" are enabled.
- **Solution:** `P2pUPIapp` was built with a two-stage lifecycle:
  - **Phase 1 (1.8s):** Translucent window with circular spinner (caller visibly paused).
  - **Phase 2:** Full-screen opaque `PaymentActivity` launched with `FLAG_ACTIVITY_FORWARD_RESULT`. This occludes the screen, forcing Android to call `onStop()`, destroy the activity, and terminate the process.

### 2. Singleton Thread Lifecycle under Activity Recreation
- **Finding:** Declaring `val jsThread = HandlerThread("zn-js")` on a singleton `object ZnBridge` causes `java.lang.IllegalThreadStateException` when `onDestroy` calls `jsThread.quitSafely()` and `onCreate` attempts to restart the terminated thread inside the lingering process.
- **Solution:** Thread lifecycle was moved to dynamic allocation: `var jsThread: HandlerThread? = null`, recreated cleanly upon each Activity revival.

### 3. Native Result Pre-Caching (`ARCHITECTURE.md §12.4`)
- **Finding:** Activity results delivered to `registerForActivityResult` run **before** Hermes JS boots.
- **Solution:** `MainActivity.commitNativeResultToFlowStore` persists the raw intent extras (`Status`, `responseCode`, `response`, `txnId`, `ApprovalRefNo`) directly into `FlowStore` (`checkout.znfs`). When Hermes initializes, the flow restores straight into `verifying` with the true outcome already in memory.

### 4. The Keypad Zombie Repeating Timer & Logical Handle Abstraction
- **Finding (The Instant Digit Eraser Bug):**
  When holding the backspace button (`⌫`) on the keypad until the amount cleared to `"0"`, holding for an extra second, releasing, and then typing any new digit (e.g. `5`), the digit appeared on screen for a single frame and was instantly erased back to `"0"`.
- **Root Cause Analysis:**
  Hermes V1 is an embedded JavaScript engine without standard Web APIs (`setTimeout`, `setInterval`). In Zero-Native, timers are bridged to Android `Handler` via host functions `__zn_setTimeout(id, delayMs)` and `__zn_clearTimeout(id)`.
  In the initial naive implementation, `setIntervalPolyfill(fn, intervalMs)` scheduled consecutive ticks by recursively re-invoking `setTimeoutPolyfill(tick, intervalMs)`. Each recursive call generated a **new physical timer ID** (`id++`), while returning only the **initial Tick 0 ID** to the calling code:
  ```ts
  // Naive Chained Implementation:
  let timerId = setTimeoutPolyfill(tick, ms); // timerId = 4
  function tick() {
    fn();
    timerId = setTimeoutPolyfill(tick, ms);   // timerId = 5, then 6, then 7...
  }
  return timerId; // Returns 4!
  ```
  When the user lifted their finger, `onBackspaceEnd` called `clearInterval(backspaceTimer)` passing ID `4`. However, ID `4` had fired seconds ago! The active timer running in Android's message queue was ID `38`.
  Because ID `38` was never cleared, it became an **immortal "Zombie Recurring Timer"** that silently invoked `onBackspaceTap()` every 150 ms indefinitely. When the user subsequently tapped `5`, the zombie timer immediately fired, erased the digit, and reset the amount to `"0"`.
- **Architectural Solution:**
  1. **Logical vs Physical Handle Decoupling:** `setInterval` must issue an immutable **logical handle** (`handleId`) that remains constant across the lifetime of the interval.
  2. **Active Cancellation Closure Map:** The runtime maintains `activeIntervals: Map<number, () => void>`. Calling `clearInterval(handleId)` invokes a closure that:
     - Sets an atomic flag `isCancelled = true` to abort any tick currently queued on the event loop.
     - Cancels the active physical timeout ID (`currentTimeoutId`) in Android's `Handler`.
  3. **Idempotent Input Guards:** Added an explicit boundary check in `onBackspaceTap`: if `prev === "0" || prev === ""`, it returns `"0"` immediately without triggering reactive state mutations.
  4. **Touch Event Discipline:** Removed redundant `onPress` from rapid-fire action buttons, relying strictly on `onTouchDown` and `onTouchUp` (mirroring ZeroBill RN `TxnEnteringAmountView.tsx:326`).
*(For deep technical specification, thread-trace diagrams, and runtime design recommendations for Argon and Opus, see [`4b-keypad-zombie-timers-architecture.md`](4b-keypad-zombie-timers-architecture.md).)*

---

## 5. Summary Comparison: Zero-Native vs React Native & Flutter

| Architecture Dimension | React Native (`166`) | Flutter Legacy (`164`) | Zero-Native Exp 4 |
|---|---|---|---|
| **Payment Flow Engine** | Hand-rolled Zustand + AsyncStorage | StateNotifier + SharedPreferences | Declarative `@flow` State Machine |
| **Crash Safety Guarantee** | Best-effort `commit()` to disk | Best-effort `commit()` | Dual-slot atomic mmap (`FlowStore`) |
| **Torn Write Recovery** | None (JSON parse crash) | None (corrupt XML/JSON) | CRC32 slot fallback |
| **Process Revival Time** | ~1,250 ms (full JS bundle reload) | ~350 ms | **91 ms** (`reportFullyDrawn`) |
| **Double /pay Guard** | Ad-hoc `isPaying` boolean | Ad-hoc state check | Guaranteed by `once` effect kind |
| **Bundle Size Impact** | ~850 KB JS bundle | Full Dart AOT | **64.07 KB** bytecode (`screen.hbc`) |


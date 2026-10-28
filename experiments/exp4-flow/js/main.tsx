// exp4-flow/js/main.tsx - Entry point with Flow Recovery Router
import { h } from "./zn/h";
import { queueOp, flushBatch } from "./zn/runtime";
import { nav, backStack } from "./zn/nav";
import { effect } from "./zn/signals";
import { AmountScreen } from "./screens/AmountScreen";
import { CheckoutScreen } from "./screens/CheckoutScreen";
import { VerifyingScreen } from "./screens/VerifyingScreen";
import { checkoutFlow } from "./flows/checkoutFlow";
import { FlowInstance } from "./zn/flow";

let currentFlow: FlowInstance<any> | null = null;

// 1. Mount Initial Base Container with root ID 0
queueOp(["c", 0, "Box"]);
queueOp(["p", 0, "fill", true]);

// 2. Cold-Start Flow Recovery Check (ARCHITECTURE §12.5)
let initialScreen = "/amount";
let initialParams: Record<string, any> = {};

if (typeof (globalThis as any).__zn_flow_load === "function") {
  try {
    const raw = (globalThis as any).__zn_flow_load("checkout");
    if (raw) {
      const savedState = JSON.parse(raw);
      console.log(`[FLOW_RESTORE] Found saved flow 'checkout' at step '${savedState.step}'`);

      const outcome = checkoutFlow.restore(savedState);
      if (outcome.status === "active" && outcome.flow) {
        currentFlow = outcome.flow;
        (globalThis as any).__activeFlow = currentFlow;
        console.log(`[FLOW_RESTORE] Successfully restored flow to step '${currentFlow.step}'`);

        // If the flow is at verifying and native pre-cached a result, execute verify effect
        const upiResult = savedState.data?.upiResult || savedState.effects?.launchUpi?.result || currentFlow.data.upiResult;
        const isRealUpiResult = upiResult && (upiResult.response || upiResult.Status || upiResult.responseCode !== undefined);

        if (isRealUpiResult) {
          currentFlow.data.upiResult = upiResult;
          currentFlow.go("verifying", { upiResult }).catch((err) => {
            console.error("[FLOW_RESTORE] Verify effect error", err);
          });
        }

        if (currentFlow.step === "verifying" || currentFlow.step === "paying" || currentFlow.step === "launchingUpi") {
          initialScreen = "/verifying";
          initialParams = {
            statusText: "Checking payment status...",
            merchantName: "Kalyan Jewellers",
          };
        }
      } else if (outcome.status === "reconcile") {
        console.log(`[FLOW_RESTORE] Flow expired with in-flight actions. Opening in reconcile!`);
        initialScreen = "/verifying";
        initialParams = {
          statusText: "Checking last payment status...",
          merchantName: "Kalyan Jewellers",
        };
      }
    }
  } catch (err) {
    console.error("[FLOW_RESTORE] Failed to parse saved flow state", err);
  }
}

// 3. Mount First Screen
// Node 0 is always AmountScreen base
const amountRootId = AmountScreen({
  onBack: () => {
    console.log("[JS] Root back pressed");
  },
});
queueOp(["i", 0, amountRootId, 0]);

if (initialScreen === "/verifying") {
  nav.push("/verifying", {
    statusText: initialParams.statusText,
    merchantName: initialParams.merchantName,
  });
}

// 4. Multi-screen Router watching backStack changes
const mountedEntryIds = new Set<number>([0]);

effect(() => {
  const stack = backStack();
  const top = stack[stack.length - 1];
  if (!top) return;

  if (!mountedEntryIds.has(top.entryId)) {
    mountedEntryIds.add(top.entryId);
    console.log(`[ROUTER] Mounting screen ${top.route} with entryId ${top.entryId}`);

    if (top.route === "/checkout") {
      CheckoutScreen({
        _rootId: top.entryId,
        amountPaise: top.params.amountPaise ?? 0,
        amountFormatted: top.params.amountFormatted ?? "0",
        cashbackPaise: top.params.cashbackPaise ?? 0,
        feePaise: top.params.feePaise ?? 0,
        toPayPaise: top.params.toPayPaise ?? 0,
        merchantName: top.params.merchantName ?? "Kalyan Jewellers",
        counterName: top.params.counterName ?? "Counter 1",
      });
    } else if (top.route === "/verifying") {
      VerifyingScreen({
        _rootId: top.entryId,
        statusText: top.params.statusText,
        merchantName: top.params.merchantName,
      });
    } else if (top.route === "/amount") {
      // Root screen at entryId 0 is already mounted on base container
      if (top.entryId !== 0) {
        const rootId = AmountScreen({ onBack: () => { } });
        queueOp(["i", top.entryId, rootId, 0]);
      }
    }
  }
});

// 5. Global Event Listener for Native UPI Results
import { registerEventHandler } from "./zn/runtime";

registerEventHandler(0, "upiResult", async (parsedResult: any) => {
  console.log(`[JS_EVENT] Received native upiResult:`, parsedResult);
  try {
    const flow = (globalThis as any).__activeFlow || currentFlow;
    if (flow) {
      (globalThis as any).__activeFlow = flow;
      flow.data.upiResult = parsedResult;
      flow.go("verifying", { upiResult: parsedResult }).catch((err) => {
        console.error("[JS_EVENT] Verify effect execution error", err);
      });
      nav.replace("/verifying", {
        statusText: "Processing payment result...",
        merchantName: "Kalyan Jewellers",
      });
    }
  } catch (err) {
    console.error("[JS_EVENT] Failed to process upiResult", err);
  }
});

registerEventHandler(0, "hardwareBack", () => {
  nav.pop();
});

// Initial flush
flushBatch();

// exp3-upi/js/main.tsx - Entry point with multi-screen router
import { h } from "./zn/h";
import { queueOp, flushBatch } from "./zn/runtime";
import { backStack } from "./zn/nav";
import { effect } from "./zn/signals";
import { AmountScreen } from "./screens/AmountScreen";
import { CheckoutScreen } from "./screens/CheckoutScreen";

// 1. Mount Initial Screen (AmountScreen) with root ID 0
queueOp(["c", 0, "Box"]);
queueOp(["p", 0, "fill", true]);

const amountRootId = AmountScreen({
  _rootId: 1,
  onBack: () => {
    console.log("[JS] Root back pressed");
  }
});
queueOp(["i", 0, amountRootId, 0]);

// 2. Multi-screen Router watching backStack changes
const mountedEntryIds = new Set<number>([0, 1]);

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
    }
  }
});

// Initial flush
flushBatch();

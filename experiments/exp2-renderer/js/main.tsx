import { h } from "./zn/h";
import { queueOp, flushBatch } from "./zn/runtime";
import { AmountScreen } from "./screens/AmountScreen";

// Create root Box node with ID 0
queueOp(["c", 0, "Box"]);
queueOp(["p", 0, "fill", true]);

// Mount AmountScreen
const screenId = AmountScreen({
  onPayNow: (paise) => {
    console.log("[JS] Pay Now pressed with amount:", paise / 100);
  },
  onBack: () => {
    console.log("[JS] Back pressed");
  },
});

queueOp(["i", 0, screenId, 0]);

// Initial render batch flush
flushBatch();

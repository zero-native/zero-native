import { signal } from "./signals";
import { queueOp, scheduleFlush, registerEventHandler, allocateNodeId } from "./runtime";

export interface NavEntry {
  route: string;
  params: Record<string, any>;
  entryId: number; // root instance ID for this screen
}

export const backStack = signal<NavEntry[]>([
  { route: "/amount", params: {}, entryId: 0 }
]);

export const currentRoute = () => {
  const stack = backStack();
  return stack[stack.length - 1];
};

export const nav = {
  push(route: string, params: Record<string, any> = {}) {
    const entryId = allocateNodeId();
    const newEntry: NavEntry = { route, params, entryId };
    backStack.set([...backStack(), newEntry]);
    
    // Emit NAV op to native
    queueOp(["nav", "push", route, params, entryId]);
    scheduleFlush();
    return entryId;
  },

  pop() {
    const current = backStack();
    if (current.length > 1) {
      const popped = current[current.length - 1];
      backStack.set(current.slice(0, -1));
      queueOp(["nav", "pop", popped.route, popped.entryId]);
      scheduleFlush();
    }
  },

  replace(route: string, params: Record<string, any> = {}) {
    const current = backStack();
    const entryId = allocateNodeId();
    const newEntry: NavEntry = { route, params, entryId };
    backStack.set([...current.slice(0, -1), newEntry]);
    queueOp(["nav", "replace", route, params, entryId]);
    scheduleFlush();
    return entryId;
  }
};

// Listen for hardware back button dispatched from MainActivity
registerEventHandler(0, "hardwareBack", () => {
  const current = backStack();
  if (current.length > 1) {
    backStack.set(current.slice(0, -1));
  }
});


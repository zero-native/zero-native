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
  },

  reset(route: string = "/amount", params: Record<string, any> = {}) {
    const entryId = 0; // Reset directly to original root entry 0
    const newEntry: NavEntry = { route, params, entryId };
    backStack.set([newEntry]);
    queueOp(["nav", "reset", route, params, entryId]);
    scheduleFlush();
    return entryId;
  }
};

// Hardware back interceptor stack (for bottom sheets, dialogs, modals)
type BackInterceptor = () => boolean; // return true if handled, false to pass through
const backInterceptors: BackInterceptor[] = [];

export function registerBackInterceptor(interceptor: BackInterceptor): () => void {
  backInterceptors.push(interceptor);
  return () => {
    const idx = backInterceptors.indexOf(interceptor);
    if (idx !== -1) backInterceptors.splice(idx, 1);
  };
}

// Listen for hardware back button dispatched from MainActivity
registerEventHandler(0, "hardwareBack", () => {
  // 1. Check if any modal / bottom sheet intercepts back
  for (let i = backInterceptors.length - 1; i >= 0; i--) {
    const handled = backInterceptors[i]();
    if (handled) return;
  }

  // 2. Otherwise navigate back in screen stack
  const current = backStack();
  if (current.length > 1) {
    nav.pop();
  } else {
    // 3. At root screen, request native app exit/backgrounding
    queueOp(["app", "exit"]);
    scheduleFlush();
  }
});


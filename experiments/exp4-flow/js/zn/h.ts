/**
 * Zero-Native JSX Pragma
 * Bridges declarative JSX with fine-grained reactive signals and native Compose nodes.
 */

import { effect } from "./signals";
import { allocateNodeId, ensureNodeIdAbove, queueOp, registerEventHandler } from "./runtime";

export type Component<P = any> = (props: P, ...children: any[]) => any;

export const Column = "Column";
export const Row = "Row";
export const Box = "Box";
export const Text = "Text";
export const Pressable = "Pressable";
export const Spacer = "Spacer";
export const Image = "Image";

function bindReactiveProp(nodeId: number, propKey: string, getter: () => any) {
  effect(() => {
    const evaluated = getter();
    queueOp(["p", nodeId, propKey, evaluated]);
  });
}

function bindReactiveChild(textNodeId: number, getter: () => any) {
  effect(() => {
    const val = getter();
    queueOp(["p", textNodeId, "text", String(val ?? "")]);
  });
}

export function h(
  type: string | Component,
  props: Record<string, any> | null,
  ...rawChildren: any[]
): any {
  // 1. Functional component
  if (typeof type === "function") {
    return type(props || {}, ...rawChildren);
  }

  // 2. Intrinsic native node (Column, Row, Box, Text, Image, Pressable, Spacer, UpiProgress)
  let nodeId: number;
  if (props && typeof props._rootId === "number") {
    nodeId = props._rootId;
    ensureNodeIdAbove(nodeId);
  } else {
    nodeId = allocateNodeId();
  }
  queueOp(["c", nodeId, type]);

  // Flatten children
  const children = rawChildren.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (key === "children") continue;

      if (key.startsWith("on") && typeof value === "function") {
        // Event callback (e.g. onPress, onTouchDown, onTouchUp)
        registerEventHandler(nodeId, key, value);
        queueOp(["p", nodeId, key, true]);
      } else if (typeof value === "function") {
        // Reactive signal getter prop
        bindReactiveProp(nodeId, key, value as () => any);
      } else {
        // Static prop
        queueOp(["p", nodeId, key, value]);
      }
    }
  }

  // Process and insert children
  let childIdx = 0;
  for (const child of children) {
    if (typeof child === "number") {
      // Child is a node ID returned from an inner h() call
      queueOp(["i", nodeId, child, childIdx++]);
    } else if (typeof child === "string" || typeof child === "number") {
      // Literal string/number child: create an implicit Text node
      const textId = allocateNodeId();
      queueOp(["c", textId, "Text"]);
      queueOp(["p", textId, "text", String(child)]);
      queueOp(["i", nodeId, textId, childIdx++]);
    } else if (typeof child === "function") {
      // Reactive function child returning text or nodes
      const textId = allocateNodeId();
      queueOp(["c", textId, "Text"]);
      bindReactiveChild(textId, child as () => any);
      queueOp(["i", nodeId, textId, childIdx++]);
    }
  }

  return nodeId;
}

export function Fragment(_props: any, ...children: any[]) {
  return children.flat(Infinity);
}

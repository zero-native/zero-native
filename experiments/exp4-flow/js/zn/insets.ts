// exp4-flow/js/zn/insets.ts - Native WindowInsets & SafeArea Provider
import { signal } from "./signals";
import { registerEventHandler } from "./runtime";
import { h } from "./h";

export interface EdgeInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export const safeAreaInsets = signal<EdgeInsets>({
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
});

// Listen for native insets updates (Edge-to-Edge status bar, nav bar, cutouts)
registerEventHandler(0, "insetsChange", (payload: any) => {
  try {
    const data = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (data && typeof data.top === "number") {
      safeAreaInsets.set({
        top: Math.round(data.top),
        bottom: Math.round(data.bottom),
        left: Math.round(data.left),
        right: Math.round(data.right),
      });
      console.log(`[INSETS] Safe area updated: top=${data.top}dp, bottom=${data.bottom}dp`);
    }
  } catch (e) {
    console.error("[INSETS] Failed to parse insets payload", e);
  }
});

export function useSafeArea(): () => EdgeInsets {
  return safeAreaInsets;
}

/**
 * Consumer-grade SafeAreaView container component
 * Automatically pads screen content away from Android 15 status bars, gesture bars, and camera punch holes
 */
export function SafeAreaView(
  props: {
    children?: any;
    edges?: ("top" | "bottom" | "left" | "right")[];
    bg?: string;
    weight?: number;
  },
  ...rawChildren: any[]
) {
  const edges = props.edges || ["top", "bottom"];
  const children = rawChildren.length > 0 ? rawChildren : (props.children ? (Array.isArray(props.children) ? props.children : [props.children]) : []);

  return h(
    "Box",
    {
      width: "100%",
      height: "100%",
      weight: props.weight,
      bg: props.bg,
      paddingTop: () => (edges.includes("top") ? safeAreaInsets().top : 0),
      paddingBottom: () => (edges.includes("bottom") ? safeAreaInsets().bottom : 0),
      paddingLeft: () => (edges.includes("left") ? safeAreaInsets().left : 0),
      paddingRight: () => (edges.includes("right") ? safeAreaInsets().right : 0),
    },
    ...children
  );
}

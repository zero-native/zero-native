// Design tokens. Imported by .tsx screens and folded into templates at build time (no runtime cost).
// Must stay side-effect free: the compiler loads this file while building.
export const c = {
  bg: "#F8FAFC",
  ink: "#0F172A",
  muted: "#64748B",
  primary: "#3D26ED",
  disabled: "#CBD5E1",
  key: "#FFFFFF",
  keypadBg: "#EEF2F7",
  success: "#15803D",
  successBg: "#DCFCE7",
  white: "#FFFFFF",
  border: "#E2E8F0",
  pillBg: "#F1F5F9",
} as const

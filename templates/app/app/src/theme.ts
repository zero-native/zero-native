// Colours and shared styles. Module-level values: the compiler folds them into the templates at build time.
export const c = {
  bg: "#F8FAFC",
  card: "#FFFFFF",
  ink: "#0F172A",
  muted: "#64748B",
  border: "#E2E8F0",
  primary: "#4F46E5",
  white: "#FFFFFF",
}

export const s = {
  screen: { flex: 1, backgroundColor: c.bg, padding: 24, gap: 16 },
  title: { fontSize: 28, fontWeight: 700, color: c.ink },
  body: { fontSize: 15, color: c.muted },
  card: { padding: 20, borderRadius: 16, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, gap: 12 },
  button: { height: 48, borderRadius: 12, backgroundColor: c.primary, justifyContent: "center", alignItems: "center" },
  buttonText: { fontSize: 16, fontWeight: 600, color: c.white },
  outline: { height: 48, borderRadius: 12, borderWidth: 1, borderColor: c.border, justifyContent: "center", alignItems: "center" },
  outlineText: { fontSize: 16, fontWeight: 600, color: c.ink },
} as const

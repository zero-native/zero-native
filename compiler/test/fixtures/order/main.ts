// Fixture for build-app.test.ts: imports b.tsx before a.tsx, so Bun usually loads B first.
import { BScreen } from "./b"
import { AScreen } from "./a"

export const screens = [BScreen, AScreen]

// Fixture for issue A16 (build-app.test.ts): screen.tsx imports names from parts.ts, a plain .ts file that imports a
// component from badge.tsx. The build used to load parts.ts at build time to read its values, and Bun then read
// badge.tsx as React JSX: "Cannot find package 'react'".
import { HomeScreen } from "./screen"

export const screens = [HomeScreen]

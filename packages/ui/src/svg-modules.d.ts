// `import Logo from "./logo.svg"` (docs/svg.md §4.1): the compiler reads the file at build time and the import gives a
// component. Included by packages/ui/src/index.ts, so every app that uses @zero-native/ui has it.
declare module "*.svg" {
  const svg: import("./index").SvgFile
  export default svg
}

// The TSX viewer screen, for routes.ts (README "Add it"):
//   import { ImageViewerScreen } from "@zeronative/image-viewer/screen"
// Its own import, not in index.ts: the screen needs Motion and registry 24, which an app that never shows it shouldn't
// need (docs/ota-requires-per-os.md §5).
export { ImageViewerScreen, type ImageViewerScreenProps } from "./ImageViewerScreen"

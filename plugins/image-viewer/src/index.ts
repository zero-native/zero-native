// The image viewer's API: ImageViewer.open (api.ts). The TSX screen apps add to their routes is its own import,
// `@zero-native/image-viewer/screen` (screen.ts): it uses Motion (useZoom) and registry 24, so a bundle that only opens
// the viewer (or uses the native `imageviewer.full` route) doesn't need them (docs/ota-requires-per-os.md §5).
export * from "./api"

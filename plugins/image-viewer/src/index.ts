// The image viewer: ImageViewer.open (api.ts) and the TSX screen apps add to their routes (ImageViewerScreen.tsx).
// The logic lives in api.ts so tests can load it without the TSX.
export * from "./api"
export { ImageViewerScreen, type ImageViewerScreenProps } from "./ImageViewerScreen"

// The PDF views. Both fill their parent, so put them in a Box or Column with a size: a style can't come through a prop, as
// layout is fixed at build time. The drawing, zoom and memory rules are in Kotlin (PdfRules.kt).
import { NativeView } from "@zero-native/ui"
import { onPdfEvent, previewProps, viewerProps, type PdfPreviewProps, type PdfViewProps } from "./api"

/** Every page, one under the other: scroll, pinch to zoom, double tap to zoom. Don't put it in a `Scroll`: it scrolls by itself. */
export function PdfView(p: PdfViewProps) {
  return <NativeView name="pdf.view" props={viewerProps(p)} onEvent={(e) => onPdfEvent(p, e)} style={{ width: "100%", height: "100%" }} />
}

/** One page and no touch, for a card. A tap on it goes to what is around it, like a Pressable. */
export function PdfPreview(p: PdfPreviewProps) {
  return <NativeView name="pdf.preview" props={previewProps(p)} onEvent={(e) => onPdfEvent(p, e)} style={{ width: "100%", height: "100%" }} />
}

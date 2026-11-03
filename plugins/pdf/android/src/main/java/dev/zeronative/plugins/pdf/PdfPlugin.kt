package dev.zeronative.plugins.pdf

import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry

/** PDFs with Android's own PdfRenderer: a download into ZnHandles.fileDir, a full viewer and a one-page preview. */
class PdfPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        // Nothing here opens a file or starts a thread: an app may never show a PDF.
        val views = PdfViews(r.context)
        r.module(PdfModule(r.context, views))
        r.view("pdf.view") { scope -> PdfViewer(scope, views) }
        r.view("pdf.preview") { scope -> PdfPreviewView(scope, views) }
        r.activityEvents(views)
    }
}

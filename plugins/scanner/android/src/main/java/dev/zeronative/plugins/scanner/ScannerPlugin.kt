package dev.zeronative.plugins.scanner

import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry

class ScannerPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.module(ScannerModule(r.context))
        r.screen("scanner.full") { scope -> ScannerScreen(scope) }
        r.view("scanner.qr") { scope -> ScannerView(scope) }
    }
}

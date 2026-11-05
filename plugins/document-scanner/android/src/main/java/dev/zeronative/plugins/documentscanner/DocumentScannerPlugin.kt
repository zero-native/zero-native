package dev.zeronative.plugins.documentscanner

import dev.zeronative.runtime.ZnLaunch
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry

class DocumentScannerPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        val module = DocScanModule(r.context)
        r.module(module)
        ZnLaunch.readResult(DocScanModule.KEY, module::onResult) // here, so it is there when a result comes after a kill
        module.startIfScanOpen() // one file check; starts ML Kit only after a kill while the scanner was open
    }
}

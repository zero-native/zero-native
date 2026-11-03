package dev.zeronative.plugins.media

import androidx.core.content.FileProvider

/** Our own class, so it can't clash with a FileProvider in the app's manifest. */
class MediaFileProvider : FileProvider()

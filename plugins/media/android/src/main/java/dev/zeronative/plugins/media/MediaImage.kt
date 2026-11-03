package dev.zeronative.plugins.media

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/** Writes [output], then moves it into place: a kill leaves either no file or a whole one. */
internal inline fun writeWhole(output: File, target: File, write: (FileOutputStream) -> Unit) {
    try {
        FileOutputStream(output).use {
            write(it)
            it.fd.sync() // or a sudden power cut could leave the new name on empty data
        }
        if (!output.renameTo(target)) throw IOException("can't move ${output.name}")
    } finally {
        output.delete()
    }
}

/** Turning one picture file into a clean JPEG. On the media thread, never the main one. */
internal object MediaImage {
    fun size(file: File): Pair<Int, Int> {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        return bounds.outWidth.coerceAtLeast(0) to bounds.outHeight.coerceAtLeast(0)
    }

    /**
     * [source] to a JPEG at [target], through [work], a scratch file. A JPEG written from pixels has no EXIF at all, so the
     * location goes with the rest, and the file's rotation is built into the pixels. See-through parts become white.
     */
    fun write(source: File, work: File, target: File, maxSize: Int, quality: Int, rotate: Int = 0, crop: Crop? = null) {
        val (width, height) = size(source)
        if (width == 0 || height == 0) throw MediaFailure("not_image", "${source.name} isn't a picture this phone can read")
        val exif = try {
            ExifInterface(source)
        } catch (_: IOException) {
            null // no EXIF to read: the picture stands as stored
        }
        val plan = MediaRules.plan(width, height, exif?.rotationDegrees ?: 0, exif?.isFlipped == true, rotate, crop, maxSize)
            ?: throw MediaFailure("invalid_crop", "the crop is outside the picture")
        try {
            val decoded = BitmapFactory.decodeFile(source.path, BitmapFactory.Options().apply { inSampleSize = plan.sample })
                ?: throw MediaFailure("not_image", "${source.name} can't be read")
            val out = draw(decoded, width, height, plan)
            decoded.recycle()
            writeWhole(work, target) { if (!out.compress(Bitmap.CompressFormat.JPEG, quality, it)) throw IOException("JPEG refused") }
            out.recycle()
        } catch (_: OutOfMemoryError) {
            throw MediaFailure("too_big", "not enough memory for this picture")
        } catch (e: IOException) {
            throw MediaFailure("write_failed", "can't write the picture: $e")
        }
    }

    /** One Matrix does it all, so the picture is filtered once. */
    private fun draw(decoded: Bitmap, width: Int, height: Int, plan: Plan): Bitmap {
        val m = Matrix()
        m.postScale(width.toFloat() / decoded.width, height.toFloat() / decoded.height) // back to the file's own pixels
        if (plan.flip) m.postScale(-1f, 1f)
        m.postRotate(plan.turn.toFloat())
        val area = RectF(0f, 0f, decoded.width.toFloat(), decoded.height.toFloat())
        m.mapRect(area)
        m.postTranslate(-area.left - plan.cropX, -area.top - plan.cropY)
        m.postScale(plan.scale.toFloat(), plan.scale.toFloat())
        val out = Bitmap.createBitmap(plan.width, plan.height, Bitmap.Config.ARGB_8888)
        Canvas(out).apply {
            drawColor(Color.WHITE)
            drawBitmap(decoded, m, Paint(Paint.FILTER_BITMAP_FLAG))
        }
        return out
    }
}

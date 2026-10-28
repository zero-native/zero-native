package dev.zeronative.exp4

import android.util.Log
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

private const val TAG = "zn-sheet"

/**
 * Production-grade Native Draggable Bottom Sheet with 120 FPS Spring Physics
 * Runs entirely on the UI thread without JavaScript worklets.
 * Dispatches onStateChange and onDismiss to Hermes JS only when the drawer settles.
 */
@Composable
fun ZnBottomSheet(node: ZnNode, modifier: Modifier = Modifier) {
    val isVisible = node.getBoolean("visible", false)
    val coroutineScope = rememberCoroutineScope()
    val configuration = LocalConfiguration.current
    val density = LocalDensity.current
    val screenHeightPx = with(density) { configuration.screenHeightDp.dp.toPx() }

    var contentHeightPx by remember { mutableFloatStateOf(0f) }
    var isInitialized by remember { mutableStateOf(false) }

    // Start completely off-screen below viewport
    val offsetY = remember { Animatable(screenHeightPx) }

    // If not visible and settled closed, render nothing to free GPU and touches
    val isClosed = !isVisible && (contentHeightPx > 0f && offsetY.value >= contentHeightPx - 1f)
    if (!isVisible && (!isInitialized || isClosed)) {
        return
    }

    // Spring specs: Bouncy open, smooth exit
    val springSpecOpen = remember {
        spring<Float>(
            dampingRatio = Spring.DampingRatioLowBouncy,
            stiffness = Spring.StiffnessMedium
        )
    }
    val springSpecDismiss = remember {
        spring<Float>(
            dampingRatio = Spring.DampingRatioNoBouncy,
            stiffness = Spring.StiffnessMedium
        )
    }

    // React to JS signal prop changes (e.g. isBreakdownOpen() -> visible)
    LaunchedEffect(isVisible, contentHeightPx) {
        if (contentHeightPx <= 0f) return@LaunchedEffect

        if (isVisible) {
            if (offsetY.value > 1f) {
                offsetY.animateTo(0f, springSpecOpen)
                Log.i(TAG, "BottomSheet opened via signal prop")
                ZnBridge.dispatchEvent(node.id, "onStateChange", "\"open\"")
            }
        } else {
            if (offsetY.value < contentHeightPx) {
                offsetY.animateTo(contentHeightPx, springSpecDismiss)
                Log.i(TAG, "BottomSheet closed via signal prop")
                ZnBridge.dispatchEvent(node.id, "onStateChange", "\"closed\"")
            }
        }
    }

    val velocityTracker = remember { VelocityTracker() }

    val dragModifier = Modifier.pointerInput(contentHeightPx) {
        if (contentHeightPx <= 0f) return@pointerInput
        detectVerticalDragGestures(
            onDragStart = {
                velocityTracker.resetTracking()
            },
            onDragEnd = {
                val velocityY = velocityTracker.calculateVelocity().y
                val currentOffset = offsetY.value
                val dismissThreshold = contentHeightPx * 0.35f

                val shouldDismiss = velocityY > 1000f || (currentOffset > dismissThreshold && velocityY > -500f)

                coroutineScope.launch {
                    if (shouldDismiss) {
                        offsetY.animateTo(
                            targetValue = contentHeightPx,
                            animationSpec = springSpecDismiss,
                            initialVelocity = velocityY
                        )
                        Log.i(TAG, "BottomSheet dismissed via fling/drag (vy=$velocityY)")
                        node.prop("visible").value = false
                        ZnBridge.dispatchEvent(node.id, "onDismiss", "{}")
                        ZnBridge.dispatchEvent(node.id, "onStateChange", "\"closed\"")
                    } else {
                        offsetY.animateTo(
                            targetValue = 0f,
                            animationSpec = springSpecOpen,
                            initialVelocity = velocityY
                        )
                        Log.i(TAG, "BottomSheet snapped open via gesture (vy=$velocityY)")
                        ZnBridge.dispatchEvent(node.id, "onStateChange", "\"open\"")
                    }
                }
            },
            onDragCancel = {
                coroutineScope.launch {
                    offsetY.animateTo(0f, springSpecOpen)
                }
            },
            onVerticalDrag = { change, dragAmount ->
                change.consume()
                velocityTracker.addPosition(change.uptimeMillis, change.position)

                val current = offsetY.value
                val newOffset = if (current + dragAmount < 0f) {
                    // Tactile rubber-band resistance when pulling upward past boundary
                    current + dragAmount * 0.25f
                } else {
                    current + dragAmount
                }

                coroutineScope.launch {
                    offsetY.snapTo(newOffset)
                }
            }
        )
    }

    // Dynamic scrim alpha tracking drag/animation progress
    val progress = if (contentHeightPx > 0f) {
        (1f - (offsetY.value / contentHeightPx)).coerceIn(0f, 1f)
    } else 0f
    val scrimAlpha = 0.5f * progress

    val bgHex = node.getString("bg", "#FFFFFF")
    val sheetBg = ZnColors.parseColor(bgHex)

    Box(modifier = Modifier.fillMaxSize()) {
        // Semi-transparent backdrop scrim
        if (scrimAlpha > 0.01f) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = scrimAlpha))
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null
                    ) {
                        coroutineScope.launch {
                            offsetY.animateTo(contentHeightPx, springSpecDismiss)
                            node.prop("visible").value = false
                            ZnBridge.dispatchEvent(node.id, "onDismiss", "{}")
                            ZnBridge.dispatchEvent(node.id, "onStateChange", "\"closed\"")
                        }
                    }
            )
        }

        // Draggable sheet container
        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .offset { IntOffset(0, offsetY.value.roundToInt()) }
                .fillMaxWidth()
                .shadow(
                    elevation = 20.dp,
                    shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
                )
                .clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp))
                .background(sheetBg)
                .onSizeChanged { size ->
                    val h = size.height.toFloat()
                    if (h > 0f && h != contentHeightPx) {
                        contentHeightPx = h
                        if (!isInitialized) {
                            isInitialized = true
                            coroutineScope.launch {
                                offsetY.snapTo(h)
                                offsetY.animateTo(0f, springSpecOpen)
                                ZnBridge.dispatchEvent(node.id, "onStateChange", "\"open\"")
                            }
                        }
                    }
                }
                .then(dragModifier)
        ) {
            Column(
                modifier = Modifier.fillMaxWidth()
            ) {
                // Drag handle bar
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 10.dp, bottom = 8.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Box(
                        modifier = Modifier
                            .width(42.dp)
                            .height(5.dp)
                            .clip(RoundedCornerShape(2.5.dp))
                            .background(Color(0xFFCBD5E1))
                    )
                }

                // Render TSX child nodes
                for (childId in node.children) {
                    key(childId) {
                        ZnView(childId)
                    }
                }
            }
        }
    }
}


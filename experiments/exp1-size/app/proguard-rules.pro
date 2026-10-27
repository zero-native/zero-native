# Proguard rules for zero-native exp1-size

-keepclassmembers class * {
    native <methods>;
}

-keep class dev.zeronative.exp1.ZnBridge {
    public static <methods>;
}

# Keep Compose internal members to ensure fair baseline comparison
-keep class androidx.compose.** { *; }

# Keep Coil image loader
-keep class coil3.** { *; }
-dontwarn coil3.**

# Scanner & Camera keep rules for reflective smoke calls
-keep class com.google.mlkit.vision.barcode.** { *; }
-keep class androidx.camera.** { *; }
-keep class com.google.mlkit.vision.documentscanner.** { *; }

# Suppress warnings for optional SDK features
-dontwarn com.google.errorprone.annotations.**

# Proguard rules for zero-native exp2-renderer

-keepclassmembers class * {
    native <methods>;
}

-keep class dev.zeronative.exp2.** { *; }

# Keep Compose
-keep class androidx.compose.** { *; }

# Keep Coil image loader
-keep class coil3.** { *; }
-dontwarn coil3.**

-dontwarn com.google.errorprone.annotations.**

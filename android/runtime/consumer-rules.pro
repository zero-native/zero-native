# Applied to every app that uses the zero-native runtime.

# JNI entry points are looked up by name from C++; R8 must not rename or remove them.
-keep class dev.zeronative.runtime.ZnNative { *; }

# libhermesvm.so loads libfbjni.so, whose JNI_OnLoad looks up fbjni's Java classes by name
# (for example com.facebook.jni.HybridData$Destructor). Without these rules a release build crashes
# when the runtime starts (found 2026-10-29, milestone 1.0).
-keep class com.facebook.jni.** { *; }
-keep,allowobfuscation @interface com.facebook.proguard.annotations.DoNotStrip
-keep @com.facebook.proguard.annotations.DoNotStrip class *
-keepclassmembers class * {
    @com.facebook.proguard.annotations.DoNotStrip *;
}
# fbjni refers to javax.annotation.Nullable, which is compile-time only and not on the app classpath.
-dontwarn javax.annotation.**

# ZnJsError.asThrowable(): crash reporters group and show JS errors by this class name. Without this rule R8 merged
# it into an unrelated exception class of the same shape (logs said coil3.network.HttpException; found 2026-10-31,
# step 4.8).
-keep class dev.zeronative.runtime.ZnJsException

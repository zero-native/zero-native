// zero-native Android runtime: the C++ core (via CMake), the JNI bridge and the Kotlin runtime.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.plugin.compose")
    id("androidx.baselineprofile")
}

android {
    namespace = "dev.zeronative.runtime"
    compileSdk = 37
    ndkVersion = "30.0.16248370"

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")

        ndk {
            abiFilters += listOf("arm64-v8a")
        }

        externalNativeBuild {
            cmake {
                cppFlags += listOf("-std=c++20", "-frtti", "-fexceptions")
                arguments += listOf("-DANDROID_STL=c++_shared")
            }
        }
    }

    buildTypes {
        // Debug also builds x86_64, so the app runs on an emulator.
        debug {
            ndk {
                abiFilters += listOf("x86_64")
            }
        }
        // Release builds every CPU type Play serves (Pavan, 2026-11-10): 32-bit ARM too (low-cost phones, many with a
        // 32-bit Android Go on 64-bit chips), and x86 / x86_64 (Chromebooks, emulators). An app's own abiFilters pick
        // what goes into its APK / AAB; Play then gives each phone only its own. `-PznArm64Only`: arm64 only, for a
        // quicker local release build (perf numbers on the Lava).
        if (!project.hasProperty("znArm64Only")) release { ndk { abiFilters += listOf("armeabi-v7a", "x86", "x86_64") } }
        // `-PznX86Release` (with the sample's same flag): also x86_64, to check an R8 build on the emulator. Off by default.
        // (Since 2026-11-10 a release has x86_64 anyway, unless -PznArm64Only.)
        if (project.hasProperty("znX86Release")) release { ndk { abiFilters += listOf("x86_64") } }
    }

    buildFeatures {
        prefab = true
        compose = true
        buildConfig = true // BuildConfig.DEBUG gates the dev client (`zn dev`); R8 drops it from release builds
    }

    // CMake copies the prefab libraries we link against into this library's output, but the Hermes AAR (an `api`
    // dependency) already ships them to the app. Leave our copies out so apps don't get "2 files found".
    packaging {
        jniLibs {
            excludes += listOf("**/libhermesvm.so", "**/libfbjni.so")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    // Hermes V1. Must match core/third_party/jsi, libjsi.so and the hermesc used to build bytecode.
    api("com.facebook.hermes:hermes-android:260318099.0.5")

    // Slot cells are Compose state (ARCHITECTURE §9.1); exposed in ZnStore's API, hence `api`.
    api(platform("androidx.compose:compose-bom:2026.09.00"))
    api("androidx.compose.runtime:runtime")
    // The renderer: Compose foundation only, no material3 (ARCHITECTURE §9.2).
    api("androidx.compose.ui:ui")
    api("androidx.compose.foundation:foundation")
    // Pressable's ripple (step 3.6). Only the ripple, not Material: Compose moved ripple() to this small artifact.
    implementation("androidx.compose.material:material-ripple")
    // The host Activity's type and its result launchers (ZnActivity). Already in every app through activity-compose.
    api("androidx.activity:activity:1.13.0")
    // Screen host: the back stack is a list we own (ARCHITECTURE §11). Needs Compose ≥ 1.10 (step 2.0b).
    implementation("androidx.navigation3:navigation3-runtime:1.2.0")
    implementation("androidx.navigation3:navigation3-ui:1.2.0")
    // Image loading. Coil 3.6 needs Compose foundation ≥ 1.12 (the BOM above has 1.12.1).
    implementation("io.coil-kt.coil3:coil-compose:3.6.3")
    implementation("io.coil-kt.coil3:coil-network-okhttp:3.6.3")
    // fetch (ZnFetch.kt) and Coil's network loader. Coil asks for OkHttp 4.12; declaring 5.x here wins (Gradle takes the
    // higher version; OkHttp 5 keeps 4.x's API). 5.x tries IPv6 and IPv4 together (fastFallback), which matters on
    // networks with broken IPv6.
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    // Already in every app through Hermes → fbjni (same version); declared so ZnNative can set it up for `Intl`.
    implementation("com.facebook.soloader:nativeloader:0.10.5")

    testImplementation("junit:junit:4.13.2")
    // Android's org.json is a stub in JVM unit tests; this is the real one (tests only: ZnBundlesTest).
    testImplementation("org.json:json:20250517")

    // The runtime's own Baseline Profile ships inside the library, so every app gets it (startup rule 6).
    // Recorded by driving the sample; only our classes are kept (Compose ships its own profile).
    baselineProfile(project(":baselineprofile"))
}

baselineProfile {
    filter {
        include("dev.zeronative.runtime.**")
    }
}

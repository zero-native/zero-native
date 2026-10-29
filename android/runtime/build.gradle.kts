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
    api("com.facebook.hermes:hermes-android:250829098.0.17")

    // Slot cells are Compose state (ARCHITECTURE §9.1); exposed in ZnStore's API, hence `api`.
    api(platform("androidx.compose:compose-bom:2026.09.00"))
    api("androidx.compose.runtime:runtime")
    // The renderer: Compose foundation only, no material3 (ARCHITECTURE §9.2).
    api("androidx.compose.ui:ui")
    api("androidx.compose.foundation:foundation")
    // Screen host: the back stack is a list we own (ARCHITECTURE §11). Needs Compose ≥ 1.10 (step 2.0b).
    implementation("androidx.navigation3:navigation3-runtime:1.2.0")
    implementation("androidx.navigation3:navigation3-ui:1.2.0")
    // Image loading (same versions as the v0 size check). Apps that load http(s) images need INTERNET permission.
    implementation("io.coil-kt.coil3:coil-compose:3.3.0")
    implementation("io.coil-kt.coil3:coil-network-okhttp:3.3.0")

    testImplementation("junit:junit:4.13.2")

    // The runtime's own Baseline Profile ships inside the library, so every app gets it (startup rule 6).
    // Recorded by driving the sample; only our classes are kept (Compose ships its own profile).
    baselineProfile(project(":baselineprofile"))
}

baselineProfile {
    filter {
        include("dev.zeronative.runtime.**")
    }
}

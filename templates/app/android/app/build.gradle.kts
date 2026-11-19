// The app's Android host. Its JS comes from app/ (bun run app:js writes it into src/main/assets).
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "__APP_ID__"
    compileSdk = 37
    ndkVersion = "30.0.16248370"

    defaultConfig {
        applicationId = "__APP_ID__"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    buildTypes {
        // Debug also packs x86_64, so the app runs on an emulator. Release stays arm64-only (docs/guide-notes.md §34).
        debug {
            ndk {
                abiFilters += listOf("x86_64")
            }
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            // Signed with the debug key so it installs; use your own release key before you publish.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        compose = true
    }

    // Bytecode and templates stay uncompressed in the APK, so the runtime maps them instead of copying them.
    androidResources {
        noCompress += listOf("hbc", "zn.ui")
    }

    packaging {
        jniLibs {
            useLegacyPackaging = false
            pickFirsts += listOf("**/libc++_shared.so")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    implementation("dev.zeronative:runtime")
    // An official plugin (also in settings.gradle.kts and package.json): implementation("dev.zeronative:plugin-location")

    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.activity:activity-compose:1.13.0")
    // Installs the runtime's Baseline Profile on sideloaded installs (Play installs it on its own).
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")
}

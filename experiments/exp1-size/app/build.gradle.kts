plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.gms.google-services")
    id("com.google.firebase.crashlytics")
}

val znVariant: String = (project.findProperty("znVariant") as? String) ?: "A"
println("==> Configuring exp1-size with Variant: $znVariant")

android {
    namespace = "dev.zeronative.exp1"
    compileSdk = 37
    ndkVersion = "30.0.16248370"

    defaultConfig {
        applicationId = "dev.zeronative.exp1"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"

        ndk {
            abiFilters += listOf("arm64-v8a")
        }

        buildConfigField("String", "ZN_VARIANT", "\"$znVariant\"")

        if (znVariant != "D") {
            externalNativeBuild {
                cmake {
                    cppFlags += listOf("-std=c++20", "-frtti", "-fexceptions")
                    arguments += listOf("-DANDROID_STL=c++_shared")
                }
            }
        }
    }

    signingConfigs {
        getByName("debug") {
            // Default Android debug keystore
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.getByName("debug")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    kotlinOptions {
        jvmTarget = "21"
    }

    buildFeatures {
        compose = true
        prefab = true
        buildConfig = true
    }

    packaging {
        jniLibs {
            useLegacyPackaging = false
            pickFirsts += listOf("**/libc++_shared.so")
        }
        resources {
            excludes += listOf(
                "META-INF/DEPENDENCIES",
                "META-INF/LICENSE",
                "META-INF/LICENSE.txt",
                "META-INF/license.txt",
                "META-INF/NOTICE",
                "META-INF/NOTICE.txt",
                "META-INF/notice.txt",
                "META-INF/ASL2.0"
            )
        }
    }

    if (znVariant != "D") {
        externalNativeBuild {
            cmake {
                path = file("src/main/cpp/CMakeLists.txt")
                version = "3.22.1"
            }
        }
    }
}

dependencies {
    // --- Compose BOM ---
    val composeBom = platform("androidx.compose:compose-bom:2024.09.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.compose.runtime:runtime")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")

    // --- Variant B: Material 3 ---
    if (znVariant == "B") {
        implementation("androidx.compose.material3:material3")
    }

    // --- Coil 3 ---
    implementation("io.coil-kt.coil3:coil-compose:3.0.4")
    implementation("io.coil-kt.coil3:coil-network-okhttp:3.0.4")

    // --- Hermes V1 (Variants A, B, C) ---
    if (znVariant != "D") {
        implementation("com.facebook.hermes:hermes-android:250829098.0.17")
    }

    // --- Scanner Suite (Variants A, B, D; omitted in C) ---
    if (znVariant != "C") {
        implementation("com.google.mlkit:barcode-scanning:17.3.0")
        implementation("com.google.android.gms:play-services-mlkit-face-detection:17.1.0")
        implementation("com.google.android.gms:play-services-mlkit-document-scanner:16.0.0")

        val cameraxVersion = "1.4.2"
        implementation("androidx.camera:camera-core:$cameraxVersion")
        implementation("androidx.camera:camera-camera2:$cameraxVersion")
        implementation("androidx.camera:camera-lifecycle:$cameraxVersion")
        implementation("androidx.camera:camera-view:$cameraxVersion")
    }

    // --- Firebase & Play Services (All Variants) ---
    implementation("com.google.firebase:firebase-analytics:22.1.2")
    implementation("com.google.firebase:firebase-messaging:24.1.0")
    implementation("com.google.firebase:firebase-crashlytics:20.1.0")

    implementation("com.google.android.gms:play-services-auth:20.6.0")
    implementation("com.google.android.gms:play-services-auth-api-phone:18.0.1")
    implementation("com.google.android.gms:play-services-location:21.0.1")
    implementation("com.google.android.play:app-update:2.1.0")
    implementation("com.android.installreferrer:installreferrer:2.2")

    // --- Production Helpers & Stores (All Variants) ---
    implementation("com.truecaller.android.sdk:truecaller-sdk:3.1.0")
    implementation("com.airbnb.android:lottie:6.6.2")
    implementation("io.github.zhongwuzw:mmkv:2.4.2")
    implementation("org.apache.commons:commons-compress:1.26.1")
    implementation("androidx.work:work-runtime:2.8.0")
}

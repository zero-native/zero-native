// Runs on the phone against the sample's release build:
//  - BaselineProfileGenerator writes the Baseline Profiles (the runtime's and the sample's),
//  - StartupBenchmark / TypingBenchmark measure cold start and frame times (docs/startup-and-performance.md).
// Generate:  .\gradlew.bat :sample:generateBaselineProfile :runtime:generateBaselineProfile
// Measure:   .\gradlew.bat :baselineprofile:connectedBenchmarkReleaseAndroidTest
plugins {
    id("com.android.test")
    id("androidx.baselineprofile")
}

android {
    namespace = "dev.zeronative.baselineprofile"
    compileSdk = 37

    defaultConfig {
        // Generating profiles without root needs Android 13+; benchmarks alone work from Android 9.
        minSdk = 28
        targetSdk = 36
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    targetProjectPath = ":sample"

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

baselineProfile {
    useConnectedDevices = true
}

dependencies {
    implementation("androidx.test.ext:junit:1.3.0")
    implementation("androidx.test.uiautomator:uiautomator:2.3.0")
    implementation("androidx.benchmark:benchmark-macro-junit4:1.5.0")
}

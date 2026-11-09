pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "zero-native"
include(":runtime")
include(":sample")
include(":baselineprofile")
include(":plugin-device-test")
project(":plugin-device-test").projectDir = file("../plugins/device-test/android")
for (name in listOf("scanner", "media", "android-play-auth", "webview")) {
    include(":plugin-$name")
    project(":plugin-$name").projectDir = file("../plugins/$name/android")
}
include(":plugin-pdf")
project(":plugin-pdf").projectDir = file("../plugins/pdf/android")
include(":plugin-location")
project(":plugin-location").projectDir = file("../plugins/location/android")
include(":plugin-firebase-crashlytics")
project(":plugin-firebase-crashlytics").projectDir = file("../plugins/firebase-crashlytics/android")
include(":plugin-notifications")
project(":plugin-notifications").projectDir = file("../plugins/notifications/android")
include(":plugin-firebase-messaging")
project(":plugin-firebase-messaging").projectDir = file("../plugins/firebase-messaging/android")
include(":plugin-firebase-app")
project(":plugin-firebase-app").projectDir = file("../plugins/firebase-app/android")
include(":plugin-firebase-analytics")
project(":plugin-firebase-analytics").projectDir = file("../plugins/firebase-analytics/android")
include(":plugin-firebase-remote-config")
project(":plugin-firebase-remote-config").projectDir = file("../plugins/firebase-remote-config/android")
include(":plugin-firebase-perf")
project(":plugin-firebase-perf").projectDir = file("../plugins/firebase-perf/android")
include(":plugin-lottie")
project(":plugin-lottie").projectDir = file("../plugins/lottie/android")
include(":plugin-document-scanner")
project(":plugin-document-scanner").projectDir = file("../plugins/document-scanner/android")
include(":plugin-device-info")
project(":plugin-device-info").projectDir = file("../plugins/device-info/android")
include(":plugin-android-ad-id")
project(":plugin-android-ad-id").projectDir = file("../plugins/android-ad-id/android")
include(":plugin-image-viewer")
project(":plugin-image-viewer").projectDir = file("../plugins/image-viewer/android")
include(":plugin-app-updates")
project(":plugin-app-updates").projectDir = file("../plugins/app-updates/android")

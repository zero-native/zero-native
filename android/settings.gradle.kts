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
for (name in listOf("scanner", "media", "auth", "webview")) {
    include(":plugin-$name")
    project(":plugin-$name").projectDir = file("../plugins/$name/android")
}
include(":plugin-pdf")
project(":plugin-pdf").projectDir = file("../plugins/pdf/android")
include(":plugin-location")
project(":plugin-location").projectDir = file("../plugins/location/android")
include(":plugin-crashlytics")
project(":plugin-crashlytics").projectDir = file("../plugins/crashlytics/android")
include(":plugin-push")
project(":plugin-push").projectDir = file("../plugins/push/android")
include(":plugin-firebase-app")
project(":plugin-firebase-app").projectDir = file("../plugins/firebase-app/android")
include(":plugin-analytics")
project(":plugin-analytics").projectDir = file("../plugins/analytics/android")
include(":plugin-remote-config")
project(":plugin-remote-config").projectDir = file("../plugins/remote-config/android")
include(":plugin-perf")
project(":plugin-perf").projectDir = file("../plugins/perf/android")

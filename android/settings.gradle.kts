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

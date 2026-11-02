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

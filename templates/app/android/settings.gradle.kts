// The Android host. zero-native isn't published yet, so it comes from a local folder as a composite build
// (zeroNativeDir in gradle.properties). When it is published, only the includeBuild block goes away: the app already
// asks for "dev.zeronative:runtime".
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

rootProject.name = "__APP_NAME__"

val zeroNativeDir = providers.gradleProperty("zeroNativeDir").get()
includeBuild("$zeroNativeDir/android") {
    dependencySubstitution {
        substitute(module("dev.zeronative:runtime")).using(project(":runtime"))
        // An official plugin the app uses, e.g. location (also in app/build.gradle.kts and package.json):
        // substitute(module("dev.zeronative:plugin-location")).using(project(":plugin-location"))
    }
}

include(":app")
// A plugin of the app's own (docs/plugins.md):
// include(":plugin-mine")
// project(":plugin-mine").projectDir = file("../plugins/mine/android")

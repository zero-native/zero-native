// Firebase's Gradle setup for an app, in one line of the app's build.gradle.kts:
//
//   apply(from = "../../plugins/firebase-app/firebase.gradle.kts")    // at the end, after dependencies { }
//
// The root build.gradle.kts must list the two Gradle plugins (`apply false`), like android/build.gradle.kts does.
//
// - google-services.json next to the app's build.gradle.kts: Firebase on. It is never committed (.gitignore), so a
//   machine or CI without it builds the same app with Firebase off, and every Firebase plugin answers
//   `available: false`. One line in the build log says so.
// - Crashlytics' Gradle plugin only when the app uses plugins/crashlytics.
// - The R8 mapping goes to Crashlytics only with `-PznUploadMapping`, so no everyday release build uploads anything.
//
// Written without Firebase's Gradle classes (a script file can't see them), so the settings are set by name.

if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
    // Asks this app's own dependencies, so it also works when zero-native comes in as an included build (there
    // `:plugin-crashlytics` lives in zero-native's build, and the app asks for "dev.zeronative:plugin-crashlytics").
    // Without the Gradle plugin, the Crashlytics SDK stops the app at start (no build id).
    val usesCrashlytics = configurations.any { c -> c.dependencies.any { it.name == "plugin-crashlytics" } }
    if (usesCrashlytics) {
        apply(plugin = "com.google.firebase.crashlytics")
        val upload = project.hasProperty("znUploadMapping")
        val buildTypes = extensions.getByName("android").withGroovyBuilder { getProperty("buildTypes") }
            as NamedDomainObjectContainer<*>
        (buildTypes.getByName("release") as ExtensionAware).extensions.getByName("firebaseCrashlytics")
            .withGroovyBuilder { setProperty("mappingFileUploadEnabled", upload) }
    }
} else {
    val json = file("google-services.json").relativeTo(rootDir.parentFile).invariantSeparatorsPath
    logger.lifecycle("zero-native: no $json, so Firebase is off in this build")
}

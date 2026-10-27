# Experiment 1: Non-Stripping Smoke Test Coverage (`SMOKE.md`)

To ensure R8 minify and resource shrinking do not artificially reduce the binary size by removing uncalled library code, `SmokeActivity.kt` exercises the following APIs at startup:

| Layer / Library | Exact API / Component Exercised | Purpose |
|---|---|---|
| **Compose UI** | `BasicText`, `Box`, `Modifier.background`, `fillMaxSize`, `scale` | Core UI Layout and drawing pipeline |
| **Compose Animation** | `Animatable.animateTo(spring(...))` | Spring animation engine on frame clock |
| **Compose Foundation** | `LazyColumn`, `items(...)` with 20 rows | Lazy list scrolling and recycling nodes |
| **Coil 3** | `AsyncImage(model = "...")` via OkHttp network loader | Image decoding, memory cache, and network pipeline |
| **Hermes Engine** | `ZnBridge.evalSmokeBytecode(assets.open("smoke.hbc"))` | Standalone Hermes bytecode VM evaluation via JSI/JNI |
| **ML Kit Barcode** | `BarcodeScanning.getClient()` | Bundled barcode model initialization |
| **CameraX** | `ProcessCameraProvider.getInstance(this)` | CameraX lifecycle and camera2 subsystem |
| **Document Scanner** | `GmsDocumentScanning.getClient(...)` | ML Kit document scanner client |
| **Firebase Analytics** | `FirebaseAnalytics.getInstance(this).logEvent("smoke_event", null)` | Analytics event dispatch |
| **Firebase Crashlytics** | `FirebaseCrashlytics.getInstance().log("smoke_test_log")` | Crashlytics session logger |
| **Firebase Messaging** | `FirebaseMessaging.getInstance().token` | FCM registration client |
| **Play Services Auth** | `Identity.getSignInClient(this)` | Credential manager & Google Sign-In |
| **Play Services Location**| `LocationServices.getFusedLocationProviderClient(this)` | Fused location client |
| **Play App Update** | `AppUpdateManagerFactory.create(this)` | In-app update manager |
| **Play Install Referrer** | `InstallReferrerClient.newBuilder(this).build()` | Install referrer client |
| **Tencent MMKV** | `MMKV.initialize(this)`, `encode(...)`, `decodeString(...)` | Mmap-backed key-value store |
| **Commons Compress** | `ZipArchiveEntry("smoke.txt")` | Archive compression utilities |
| **WorkManager** | `WorkManager.getInstance(this)` | Background task scheduler |
| **Lottie** | `LottieCompositionFactory.fromAsset(this, "dummy.json")` | Vector animation parser |
| **Truecaller SDK** | `TruecallerSdkScope.Builder(this, ...).build()` | Partner verification SDK initialization |

# Experiment 1: Size Check Report (`1-result-exp1-size.md`)

**Date:** 2026-10-27  
**Device Spec:** Lava Blaze 2 5G (`arm64-v8a`, `xhdpi`, `SDK 34`, `en-IN`) via `device.json`  
**Measurement Method:** `bundletool` (1.18.3) + `brotli -q 11` (matches Google Play download delivery)  
**Result:** **PASS (6.42 MB ≤ 10.0 MB Pass Threshold)**

---

## 1. Executive Summary

Experiment 1 tests the core commercial hypothesis of zero-native:
> *"If we remove React Native but keep everything the app really needs, how big is the Play download?"*

### Result Table

| Variant | Configuration | Disk Footprint (APKs on device) | Play Download Size (Brotli -q 11) | Delta vs Variant A | Pass / Fail Status |
|:---:|---|:---:|:---:|:---:|:---:|
| **Variant A** | **Base: Compose + Coil 3 + Hermes V1 + Bundled ML Kit + Firebase + Play Services** | **19.02 MiB** (19,942,340 B) | **6.42 MB** (6,422,175 B) | *Baseline* | **PASS** (Limit: ≤ 10.0 MB) |
| **Variant B** | Variant A + `material3` | 21.17 MiB (22,199,605 B) | **7.00 MB** (6,996,201 B) | +0.58 MB (+574 KB) | **PASS** |
| **Variant C** | Variant A - Scanner Suite (No ML Kit, CameraX, Doc Scanner) | 12.75 MiB (13,366,426 B) | **4.12 MB** (4,116,440 B) | -2.30 MB (-2,305 KB) | Informational |
| **Variant D** | Variant A - Hermes Engine (No Hermes VM or C++ Bridge) | 17.69 MiB (18,545,449 B) | **6.03 MB** (6,033,641 B) | -0.39 MB (-388 KB) | Informational |
| *Reference* | **React Native 1.8.0 (`166.aab`)** | **23.90 MiB** (25,061,054 B) | **14.88 MB** (14,878,829 B) | **+8.46 MB (+132%)** | Current Store Baseline |
| *Reference* | **Flutter 1.6.0 (`164.aab`)** | **38.83 MiB** (40,714,665 B) | **13.06 MB** (13,057,622 B) | **+6.64 MB (+103%)** | Legacy Flutter Baseline |

---

## 2. Breakdown Analysis: Where Does the Size Go?

From the 4 variants measured under identical R8 optimization and smoke-screen exercise:

1. **Scanner Suite Share (`libbarhopper_v3.so` + CameraX + ML Kit):**
   - **2.30 MB Play Download** (Variant A: 6.42 MB vs Variant C: 4.12 MB).
   - This accounts for ~36% of the entire zero-native app download. Bundled barcode scanning remains the single largest library, exactly as expected.
2. **Material 3 Component Cost:**
   - **0.58 MB (574 KB) Play Download** (Variant A: 6.42 MB vs Variant B: 7.00 MB).
   - Rebuilding custom ZeroBill UI atoms directly on `androidx.compose.foundation` (Variant A) saves over half a megabyte compared to shipping the Material 3 design library.
3. **Hermes V1 Engine Cost:**
   - **0.39 MB (388 KB) Play Download** delta when completely dropping `libhermesvm.so`, `libjsi.so`, and `libzn.so`.
   - On disk: ~1.40 MB uncompressed APK reduction.
   - Brotli compresses the Hermes VM bytecode engine down to under 400 KB over the wire.
4. **Core Application Base (Compose + Coil + Firebase + Play Services + WorkManager + MMKV):**
   - **~3.73 MB Play Download** (Variant C without Scanner minus Hermes).

---

## 3. Native Libraries in Variant A Release (`arm64-v8a`)

All 11 `.so` files present in `variant-A.aab` (`base/lib/arm64-v8a/`):

| Library | Raw Uncompressed Size | Provider | Verified Functioning? |
|---|---|---|:---:|
| `libbarhopper_v3.so` | 4,946,720 B (~4.95 MB) | ML Kit Barcode Scanning | YES |
| `libhermesvm.so` | 2,477,320 B (~2.48 MB) | Hermes Android 250829098.0.17 | YES |
| `libc++_shared.so` | 1,423,696 B (~1.42 MB) | Android NDK 30 | YES |
| `libjsi.so` | 412,696 B (~0.41 MB) | Vendored from react-android (exact parity) | YES |
| `libmmkv.so` | 361,392 B (~0.36 MB) | Tencent MMKV 2.4.2 | YES |
| `libfbjni.so` | 177,000 B (~0.18 MB) | fbjni 0.7.0 | YES |
| `libzn.so` | 43,856 B (~0.04 MB) | Zero-native C++ JNI bridge | YES |
| `libimage_processing_util_jni.so` | 29,008 B (~0.03 MB) | CameraX 1.4.2 | YES |
| `libandroidx.graphics.path.so` | 10,096 B (~0.01 MB) | Compose Foundation Graphics | YES |
| `libdatastore_shared_counter.so` | 7,112 B (~0.01 MB) | AndroidX DataStore | YES |
| `libsurface_util_jni.so` | 4,832 B (~0.005 MB) | CameraX 1.4.2 | YES |
| **Total Native Code** | **9,893,728 B (~9.89 MB)** | **11 Libraries** (down from 27 in RN) | **All Verified** |

---

## 4. Verification of Non-Stripping R8 Smoke Test

`SmokeActivity.kt` touched every critical dependency at startup (logged in Logcat under tag `SmokeActivity`):
- Compose `BasicText`, `LazyColumn` (20 rows), `Animatable` spring animation.
- Coil 3 `AsyncImage` with network OkHttp fetcher.
- Hermes engine evaluation of `1+1` from `smoke.hbc` via `ZnBridge.evalSmokeBytecode()`.
- ML Kit `BarcodeScanning.getClient()` & CameraX `ProcessCameraProvider`.
- Firebase Analytics, Crashlytics (`smoke_test_log`), Messaging token request.
- Play Services Auth `Identity.getSignInClient()`, Fused Location, Document Scanner, App Update, Install Referrer.
- MMKV initialization & key write/read.
- Apache Commons Compress, WorkManager, Lottie composition factory, Truecaller SDK initialization.

---

## 5. Conclusion & Pass/Fail Gate

* **Pass Threshold:** ≤ 10.0 MB
* **Actual Measured Result:** **6.42 MB**
* **Margin:** **3.58 MB under the maximum limit!**
* **Compared to RN 1.8.0:** **-8.46 MB (-57% reduction in Play Store download size).**
* **Compared to Flutter 1.6.0:** **-6.64 MB (-51% reduction in Play Store download size).**

The size argument for zero-native is **decisively validated**. Even after adding real-world app screens, icons, fonts, and a 2 MB Hermes bytecode bundle in production, the overall download will comfortably stay within the **7.5 MB – 8.5 MB** range.

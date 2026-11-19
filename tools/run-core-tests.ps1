# Builds the C++ core tests with the Android NDK and runs them on the connected phone.
# Usage (from the repo root, PowerShell):  .\tools\run-core-tests.ps1
# Exit code 0 = all tests passed.
# 'Continue': adb and cmake print progress on stderr, which PowerShell 5.1 would otherwise treat as an error.
# Failures are detected through $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$ndk = Join-Path $sdk 'ndk\30.0.16248370'
$cmakeDir = Join-Path $sdk 'cmake\4.1.2\bin'  # as android/runtime/build.gradle.kts
$cmake = Join-Path $cmakeDir 'cmake.exe'
$ninja = Join-Path $cmakeDir 'ninja.exe'
$buildDir = Join-Path $root 'build\core-tests'

foreach ($p in @($ndk, $cmake, $ninja)) {
    if (-not (Test-Path $p)) { throw "Missing: $p (install it with the Android SDK manager)" }
}

& $cmake -S (Join-Path $root 'core') -B $buildDir -G Ninja `
    "-DCMAKE_MAKE_PROGRAM=$ninja" `
    "-DCMAKE_TOOLCHAIN_FILE=$ndk\build\cmake\android.toolchain.cmake" `
    -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-24 -DANDROID_STL=c++_static `
    -DCMAKE_BUILD_TYPE=Release -DZN_BUILD_TESTS=ON | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'CMake configure failed' }

& $cmake --build $buildDir --target zn_core_tests
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }

$exe = Join-Path $buildDir 'zn_core_tests'
adb push $exe /data/local/tmp/zn_core_tests 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'adb push failed (is the phone connected?)' }
adb shell chmod 755 /data/local/tmp/zn_core_tests
adb shell /data/local/tmp/zn_core_tests
$code = $LASTEXITCODE
if ($code -ne 0) { Write-Host "Core tests FAILED (exit $code)"; exit $code }

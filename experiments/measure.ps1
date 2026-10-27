param(
    [Parameter(Mandatory=$true)]
    [string]$AabPath,

    [string]$DeviceSpec = "device.json",
    [string]$BundleTool = "stuff/bundletool-all-1.18.3.jar",
    [string]$BrotliPath = "C:\Program Files\Git\mingw64\bin\brotli.exe"
)

if (-not (Test-Path $AabPath)) {
    Write-Error "AAB file not found at: $AabPath"
    exit 1
}

if (-not (Test-Path $DeviceSpec)) {
    Write-Error "Device spec file not found at: $DeviceSpec"
    exit 1
}

$tempName = [System.IO.Path]::GetFileNameWithoutExtension($AabPath)
$apksPath = "out_$tempName.apks"
$extractDir = "out_$tempName"

if (Test-Path $extractDir) {
    Remove-Item -Recurse -Force $extractDir
}
if (Test-Path $apksPath) {
    Remove-Item -Force $apksPath
}

Write-Host "==> [1/3] Building APKs with bundletool..." -ForegroundColor Cyan
& java -jar $BundleTool build-apks --bundle=$AabPath --output=$apksPath --overwrite
if ($LASTEXITCODE -ne 0) {
    Write-Error "bundletool build-apks failed."
    exit 1
}

Write-Host "==> [2/3] Extracting device-matched APKs..." -ForegroundColor Cyan
& java -jar $BundleTool extract-apks --apks=$apksPath --device-spec=$DeviceSpec --output-dir=$extractDir
if ($LASTEXITCODE -ne 0) {
    Write-Error "bundletool extract-apks failed."
    exit 1
}

Write-Host "==> [3/3] Calculating sizes (Disk & Play Brotli -q 11)..." -ForegroundColor Cyan
$apks = Get-ChildItem -Path $extractDir -Filter "*.apk"
$rawDiskBytes = ($apks | Measure-Object -Property Length -Sum).Sum

$bashScript = "cat $extractDir/*.apk | /mingw64/bin/brotli.exe -q 11 -c | wc -c"
$brotliBytesStr = & "C:\Program Files\Git\bin\bash.exe" -c $bashScript
$brotliBytes = [int64]($brotliBytesStr.Trim())

$rawDiskMB = [math]::Round($rawDiskBytes / 1MB, 2)
$brotliMB = [math]::Round($brotliBytes / 1MB, 2)
$brotliDecimalMB = [math]::Round($brotliBytes / 1000000, 2)

Write-Host "`n========================================================" -ForegroundColor Green
Write-Host "Measurement Report for: $([System.IO.Path]::GetFileName($AabPath))" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host "Device Spec:          $DeviceSpec (Lava Blaze 2 5G: arm64-v8a, xhdpi, SDK 34)"
Write-Host "Extracted APK count:  $($apks.Count)"
Write-Host "Disk Footprint:       $rawDiskMB MiB ($rawDiskBytes bytes)"
Write-Host "Play Download Size:   $brotliDecimalMB MB ($brotliMB MiB, $brotliBytes bytes)"
Write-Host "========================================================`n" -ForegroundColor Green

# Clean up temporary apks archive and extracted folder
Remove-Item -Force $apksPath -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue

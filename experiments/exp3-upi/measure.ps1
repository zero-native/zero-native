# exp3-upi/measure.ps1 - Automated Multi-Screen Navigation & UPI Lifecycle Benchmark
param(
    [string]$DeviceId = "<phone-serial>"
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   ZERO-NATIVE EXP 3: NAVIGATION & UPI BENCHMARK SUITE     " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Device: $DeviceId (Lava Blaze 2 5G)"
Write-Host ""

# Ensure device is awake and reachable
$state = (adb -s $DeviceId get-state) 2>$null
if ($state -ne "device") {
    Write-Error "Device $DeviceId is not reachable (state: $state)"
    exit 1
}

# -----------------------------------------------------------------------------
# STEP 1: Cold Start AmountScreen
# -----------------------------------------------------------------------------
Write-Host ">>> [1/5] Launching AmountScreen (Screen 1)..." -ForegroundColor Yellow
adb -s $DeviceId shell am force-stop dev.zeronative.exp3 | Out-Null
Start-Sleep -Milliseconds 600
adb -s $DeviceId logcat -c | Out-Null

$startOut = (adb -s $DeviceId shell am start -W -n dev.zeronative.exp3/.MainActivity) | Out-String
$totalTime = 0
if ($startOut -match "TotalTime:\s*(\d+)") {
    $totalTime = [int]$Matches[1]
}

Start-Sleep -Milliseconds 800
$logcat = (adb -s $DeviceId logcat -d -s zn:V) | Out-String
$drawnTime = 0
if ($logcat -match "reportFullyDrawn: Initial screen rendered in (\d+) ms") {
    $drawnTime = [int]$Matches[1]
}
Write-Host "  AmountScreen Launched: TotalTime=${totalTime}ms, FullyDrawn=${drawnTime}ms" -ForegroundColor Green

# -----------------------------------------------------------------------------
# STEP 2: Input Amount "500" via Keypad
# -----------------------------------------------------------------------------
Write-Host "`n>>> [2/5] Inputting Amount '500' on Keypad..." -ForegroundColor Yellow
# Tap '5' (x=360, y=1020)
adb -s $DeviceId shell input tap 360 1020
Start-Sleep -Milliseconds 150
# Tap '0' (x=360, y=1300)
adb -s $DeviceId shell input tap 360 1300
Start-Sleep -Milliseconds 150
# Tap '0' (x=360, y=1300)
adb -s $DeviceId shell input tap 360 1300
Start-Sleep -Milliseconds 300

# -----------------------------------------------------------------------------
# STEP 3: Navigate Screen 1 -> Screen 2 (CheckoutScreen)
# -----------------------------------------------------------------------------
Write-Host "`n>>> [3/5] Navigating to CheckoutScreen (Tap 'Pay Now')..." -ForegroundColor Yellow
# Tap 'Pay Now' (x=360, y=1440)
adb -s $DeviceId shell input tap 360 1440
Start-Sleep -Milliseconds 800

$navLog = (adb -s $DeviceId logcat -d -s zn-nav:V zn:V) | Out-String
if ($navLog -match "\[NAV\] push: route=/checkout") {
    Write-Host "  [OK] Forward Transition Triggered: route=/checkout pushed successfully!" -ForegroundColor Green
} else {
    Write-Host "  [WAIT] Checking nav log output..." -ForegroundColor Gray
}

# -----------------------------------------------------------------------------
# STEP 4: Test Back Navigation (Screen 2 -> Screen 1)
# -----------------------------------------------------------------------------
Write-Host "`n>>> [4/5] Testing Back Navigation (Screen 2 -> Screen 1)..." -ForegroundColor Yellow
# Tap on-screen Back button (x=110, y=80)
adb -s $DeviceId shell input tap 110 80
Start-Sleep -Milliseconds 600

$backLog = (adb -s $DeviceId logcat -d -s zn-nav:V zn:V) | Out-String
if ($backLog -match "\[NAV\] pop: popped route=/checkout") {
    Write-Host "  [OK] Reverse Transition Triggered: popped /checkout, returned to /amount!" -ForegroundColor Green
}

# Re-enter CheckoutScreen for UPI test
Write-Host "  Re-navigating to CheckoutScreen for UPI lifecycle test..." -ForegroundColor Gray
adb -s $DeviceId shell input tap 360 1440
Start-Sleep -Milliseconds 800

# -----------------------------------------------------------------------------
# STEP 5: Launch UPI Intent & Measure Animation Frames during onPause()
# -----------------------------------------------------------------------------
Write-Host "`n>>> [5/5] Launching UPI Intent & Profiling Frame Delivery during onPause()..." -ForegroundColor Yellow

# Clear logcat to cleanly capture frame timestamps
adb -s $DeviceId logcat -c | Out-Null

# Tap PhonePe tile (x=360, y=440)
Write-Host "  Tapping PhonePe UPI App Tile to trigger intent dispatch..." -ForegroundColor Cyan
adb -s $DeviceId shell input tap 360 440

# Wait 3 seconds to let 800ms dispatch occur, onPause happen, and 2.4s fallback canvas execute
Write-Host "  Recording frames during onPause() lifecycle window (3.5s)..." -ForegroundColor Cyan
Start-Sleep -Milliseconds 3500

# Fetch full logcat
$perfLog = (adb -s $DeviceId logcat -d -s zn:V zn-frame:V zn-upi:V) | Out-String

# Press Back on phone to return from UPI app to ZeroBill
adb -s $DeviceId shell input keyevent KEYCODE_BACK | Out-Null
Start-Sleep -Milliseconds 500

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host "               LIFECYCLE & FRAME RESULTS                  " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green

# Parse Lifecycle timestamps
$onPauseMatch = [regex]::Match($perfLog, "\[LIFECYCLE\] onPause at (\d+) ns")
$onStopMatch = [regex]::Match($perfLog, "\[LIFECYCLE\] onStop at (\d+) ns")
$onResumeMatch = [regex]::Match($perfLog, "\[LIFECYCLE\] onResume at (\d+) ns")

if ($onPauseMatch.Success) {
    Write-Host "  [LIFECYCLE] onPause:  $($onPauseMatch.Groups[1].Value) ns" -ForegroundColor Green
} else {
    Write-Host "  [LIFECYCLE] onPause:  (Activity remained in foreground or intent fired)" -ForegroundColor Gray
}

if ($onStopMatch.Success) {
    Write-Host "  [LIFECYCLE] onStop:   $($onStopMatch.Groups[1].Value) ns" -ForegroundColor Yellow
} else {
    Write-Host "  [LIFECYCLE] onStop:   NOT reached (translucent window kept activity in onPause)" -ForegroundColor Green
}

# Parse Frame Timestamps
$frameMatches = [regex]::Matches($perfLog, "\[FRAME\] native_bar progress=([\d\.]+) dt=([\d\.]+)ms")
$dts = @()

foreach ($m in $frameMatches) {
    $val = [double]$m.Groups[1].Value
    $dt = [double]$m.Groups[2].Value
    if ($dt -gt 0 -and $dt -lt 500) {
        $dts += $dt
    }
}

if ($dts.Count -gt 0) {
    $sorted = $dts | Sort-Object
    $p50Index = [int](0.50 * $sorted.Count)
    $p95Index = [int](0.95 * $sorted.Count)
    $p50 = $sorted[$p50Index]
    $p95 = $sorted[$p95Index]
    $dropped = ($dts | Where-Object { $_ -gt 25.0 }).Count

    Write-Host "`n  Total Frames Captured: $($dts.Count)" -ForegroundColor Green
    Write-Host "  p50 Frame Delta (dt):  ${p50} ms" -ForegroundColor Green
    Write-Host "  p95 Frame Delta (dt):  ${p95} ms" -ForegroundColor Green
    Write-Host "  Frames > 25ms (drops): $dropped / $($dts.Count) ($([math]::Round(($dropped / $dts.Count) * 100, 1))%)" -ForegroundColor $(if ($dropped -eq 0) { "Green" } else { "Yellow" })
} else {
    Write-Host "  [INFO] Raw Log Snippet:" -ForegroundColor Gray
    $perfLog.Split("`n") | Select-Object -Last 20 | ForEach-Object { Write-Host "    $_" }
}

Write-Host "==========================================================" -ForegroundColor Green

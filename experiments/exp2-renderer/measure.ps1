# measure.ps1 - Automated Benchmark Suite for Zero-Native Exp 2 vs React Native
param(
    [string]$DeviceId = "<phone-serial>",
    [int]$ColdStartRuns = 10,
    [int]$TapRuns = 100
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   ZERO-NATIVE EXP 2 BENCHMARK SUITE (Lava Blaze 2 5G)    " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Device: $DeviceId"
Write-Host ""

# -----------------------------------------------------------------------------
# BENCHMARK 1: COLD-START LATENCY
# -----------------------------------------------------------------------------
Write-Host ">>> [1/4] Measuring Cold-Start Latency ($ColdStartRuns runs)..." -ForegroundColor Yellow

$znColdTimes = @()
$znDrawnTimes = @()

for ($i = 1; $i -le $ColdStartRuns; $i++) {
    adb -s $DeviceId shell am force-stop dev.zeronative.exp2 | Out-Null
    Start-Sleep -Milliseconds 800
    adb -s $DeviceId logcat -c | Out-Null
    
    $startOut = (adb -s $DeviceId shell am start -W -n dev.zeronative.exp2/.MainActivity) | Out-String
    $totalTime = 0
    if ($startOut -match "TotalTime:\s*(\d+)") {
        $totalTime = [int]$Matches[1]
        $znColdTimes += $totalTime
    }
    
    Start-Sleep -Milliseconds 600
    $logcat = (adb -s $DeviceId logcat -d -s zn:V) | Out-String
    $drawnTime = 0
    if ($logcat -match "reportFullyDrawn: Amount screen rendered in (\d+) ms") {
        $drawnTime = [int]$Matches[1]
        $znDrawnTimes += $drawnTime
    }
    Write-Host "  Zero-Native Run ${i}: TotalTime=${totalTime}ms, FullyDrawn=${drawnTime}ms"
}

# React Native Staging Cold Start
$rnColdTimes = @()
Write-Host "`nMeasuring React Native Staging Cold-Start ($ColdStartRuns runs)..." -ForegroundColor Yellow

for ($i = 1; $i -le $ColdStartRuns; $i++) {
    adb -s $DeviceId shell am force-stop com.example.app.staging | Out-Null
    Start-Sleep -Milliseconds 800
    
    $startOut = (adb -s $DeviceId shell am start -W -n com.example.app.staging/com.example.app.MainActivity) | Out-String
    $totalTime = 0
    if ($startOut -match "TotalTime:\s*(\d+)") {
        $totalTime = [int]$Matches[1]
        $rnColdTimes += $totalTime
        Write-Host "  React Native Run ${i}: TotalTime=${totalTime}ms"
    } else {
        Write-Host "  React Native Run ${i}: (start time not parsed)"
    }
}

# Flutter Legacy Cold Start
$flutterColdTimes = @()
Write-Host "`nMeasuring Flutter Legacy Cold-Start ($ColdStartRuns runs)..." -ForegroundColor Yellow

for ($i = 1; $i -le $ColdStartRuns; $i++) {
    adb -s $DeviceId shell am force-stop com.example.app | Out-Null
    Start-Sleep -Milliseconds 800
    
    $startOut = (adb -s $DeviceId shell am start -W -n com.example.app/.MainActivity) | Out-String
    $totalTime = 0
    if ($startOut -match "TotalTime:\s*(\d+)") {
        $totalTime = [int]$Matches[1]
        $flutterColdTimes += $totalTime
        Write-Host "  Flutter Run ${i}: TotalTime=${totalTime}ms"
    } else {
        Write-Host "  Flutter Run ${i}: (start time not parsed)"
    }
}

function Get-Stats($arr) {
    if ($arr.Count -eq 0) { return @{ Min=0; Max=0; Mean=0; Median=0 } }
    $sorted = $arr | Sort-Object
    $min = $sorted[0]
    $max = $sorted[-1]
    $sum = ($sorted | Measure-Object -Sum).Sum
    $mean = [math]::Round($sum / $sorted.Count, 1)
    $mid = [math]::Floor($sorted.Count / 2)
    $median = if ($sorted.Count % 2 -eq 0) { [math]::Round(($sorted[$mid-1] + $sorted[$mid]) / 2, 1) } else { $sorted[$mid] }
    return @{ Min=$min; Max=$max; Mean=$mean; Median=$median }
}

$znColdStats = Get-Stats $znColdTimes
$znDrawnStats = Get-Stats $znDrawnTimes
$rnColdStats = Get-Stats $rnColdTimes
$flutterColdStats = Get-Stats $flutterColdTimes

Write-Host "`n--- Cold Start Summary ---" -ForegroundColor Green
Write-Host "Zero-Native (am start TotalTime): Min=$($znColdStats.Min)ms, Median=$($znColdStats.Median)ms, Mean=$($znColdStats.Mean)ms, Max=$($znColdStats.Max)ms"
Write-Host "Zero-Native (reportFullyDrawn):   Min=$($znDrawnStats.Min)ms, Median=$($znDrawnStats.Median)ms, Mean=$($znDrawnStats.Mean)ms, Max=$($znDrawnStats.Max)ms"
Write-Host "React Native (am start TotalTime): Min=$($rnColdStats.Min)ms, Median=$($rnColdStats.Median)ms, Mean=$($rnColdStats.Mean)ms, Max=$($rnColdStats.Max)ms"
Write-Host "Flutter Legacy (am start TotalTime): Min=$($flutterColdStats.Min)ms, Median=$($flutterColdStats.Median)ms, Mean=$($flutterColdStats.Mean)ms, Max=$($flutterColdStats.Max)ms"

# -----------------------------------------------------------------------------
# BENCHMARK 2: TAP-TO-UPDATE LATENCY (100 TAPS)
# -----------------------------------------------------------------------------
Write-Host "`n>>> [2/4] Measuring Tap-to-Update Latency ($TapRuns taps)..." -ForegroundColor Yellow

# Ensure Zero-Native is running and in foreground
adb -s $DeviceId shell am start -n dev.zeronative.exp2/.MainActivity | Out-Null
Start-Sleep -Milliseconds 1500
adb -s $DeviceId logcat -c | Out-Null

$keys = @(
    @{ X=361; Y=856; Name="2" },
    @{ X=361; Y=1000; Name="5" },
    @{ X=361; Y=1288; Name="0" },
    @{ X=131; Y=856; Name="1" },
    @{ X=590; Y=1288; Name="Backspace" },
    @{ X=590; Y=856; Name="3" },
    @{ X=131; Y=1000; Name="4" },
    @{ X=590; Y=1288; Name="Backspace" }
)

for ($i = 0; $i -lt $TapRuns; $i++) {
    $k = $keys[$i % $keys.Count]
    adb -s $DeviceId shell input tap $($k.X) $($k.Y) | Out-Null
    Start-Sleep -Milliseconds 70
}

Start-Sleep -Milliseconds 500
$tapLogs = (adb -s $DeviceId logcat -d -s zn:V) | Out-String
$latencies = @()
$batchApplies = @()

foreach ($line in ($tapLogs -split "`n")) {
    if ($line -match "\[LATENCY\] tap-to-update applied in ([\d\.]+) ms \(batch apply: ([\d\.]+) ms\)") {
        $latencies += [double]$Matches[1]
        $batchApplies += [double]$Matches[2]
    }
}

function Get-Percentile($arr, $p) {
    if ($arr.Count -eq 0) { return 0 }
    $sorted = $arr | Sort-Object
    $idx = [math]::Ceiling(($p / 100.0) * $sorted.Count) - 1
    if ($idx -lt 0) { $idx = 0 }
    if ($idx -ge $sorted.Count) { $idx = $sorted.Count - 1 }
    return $sorted[$idx]
}

Write-Host "Recorded $($latencies.Count) tap latency samples."
if ($latencies.Count -gt 0) {
    $p50 = Get-Percentile $latencies 50
    $p90 = Get-Percentile $latencies 90
    $p95 = Get-Percentile $latencies 95
    $p99 = Get-Percentile $latencies 99
    $min = ($latencies | Measure-Object -Minimum).Minimum
    $max = ($latencies | Measure-Object -Maximum).Maximum
    $mean = [math]::Round(($latencies | Measure-Object -Average).Average, 2)
    $meanBatch = [math]::Round(($batchApplies | Measure-Object -Average).Average, 2)

    Write-Host "`n--- Tap-to-Update Latency Summary (Target: p95 <= 16 ms) ---" -ForegroundColor Green
    Write-Host "  Samples:    $($latencies.Count)"
    Write-Host "  Min:        $min ms"
    Write-Host "  p50:        $p50 ms"
    Write-Host "  p90:        $p90 ms"
    Write-Host "  p95:        $p95 ms  <--- CRITICAL TARGET" -ForegroundColor Cyan
    Write-Host "  p99:        $p99 ms"
    Write-Host "  Max:        $max ms"
    Write-Host "  Mean:       $mean ms"
    Write-Host "  Mean Batch: $meanBatch ms"
}

# -----------------------------------------------------------------------------
# BENCHMARK 3: JANK FRAME % (GFXINFO DURING 30 RAPID TAPS)
# -----------------------------------------------------------------------------
Write-Host "`n>>> [3/4] Measuring Jank Frame % (30 rapid taps)..." -ForegroundColor Yellow

adb -s $DeviceId shell dumpsys gfxinfo dev.zeronative.exp2 reset | Out-Null

for ($i = 0; $i -lt 30; $i++) {
    $k = $keys[$i % $keys.Count]
    adb -s $DeviceId shell input tap $($k.X) $($k.Y) | Out-Null
    Start-Sleep -Milliseconds 45
}

Start-Sleep -Milliseconds 800
$gfxOut = (adb -s $DeviceId shell dumpsys gfxinfo dev.zeronative.exp2) | Out-String

Write-Host "`n--- GFXINFO Summary ---" -ForegroundColor Green
if ($gfxOut -match "Total frames rendered:\s*(\d+)") { Write-Host "  Total frames rendered: $($Matches[1])" }
if ($gfxOut -match "Janky frames:\s*(\d+)\s*\(([\d\.]+)%\)") {
    Write-Host "  Janky frames:          $($Matches[1]) ($($Matches[2])%)" -ForegroundColor Cyan
}
if ($gfxOut -match "50th percentile:\s*(\d+)ms") { Write-Host "  50th percentile:       $($Matches[1]) ms" }
if ($gfxOut -match "90th percentile:\s*(\d+)ms") { Write-Host "  90th percentile:       $($Matches[1]) ms" }
if ($gfxOut -match "95th percentile:\s*(\d+)ms") { Write-Host "  95th percentile:       $($Matches[1]) ms" }
if ($gfxOut -match "99th percentile:\s*(\d+)ms") { Write-Host "  99th percentile:       $($Matches[1]) ms" }

# -----------------------------------------------------------------------------
# BENCHMARK 4: MEMORY PSS (AFTER 10s IDLE)
# -----------------------------------------------------------------------------
Write-Host "`n>>> [4/4] Measuring Memory PSS (after 10s idle)..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

$memZn = (adb -s $DeviceId shell dumpsys meminfo dev.zeronative.exp2) | Out-String

function Parse-Mem($str) {
    $native = 0; $java = 0; $total = 0
    if ($str -match "Native Heap\s+(\d+)") { $native = [int]$Matches[1] }
    if ($str -match "Dalvik Heap\s+(\d+)") { $java = [int]$Matches[1] }
    if ($str -match "TOTAL PSS:\s+(\d+)") { $total = [int]$Matches[1] }
    return @{ Native=$native; Java=$java; Total=$total }
}

$znMem = Parse-Mem $memZn

# Measure React Native Staging after cold start and 10s idle
adb -s $DeviceId shell am force-stop com.example.app.staging | Out-Null
Start-Sleep -Milliseconds 500
adb -s $DeviceId shell am start -n com.example.app.staging/com.example.app.MainActivity | Out-Null
Start-Sleep -Seconds 10
$memRn = (adb -s $DeviceId shell dumpsys meminfo com.example.app.staging) | Out-String
$rnMem = Parse-Mem $memRn

# Measure Flutter Legacy after cold start and 10s idle
adb -s $DeviceId shell am force-stop com.example.app | Out-Null
Start-Sleep -Milliseconds 500
adb -s $DeviceId shell am start -n com.example.app/.MainActivity | Out-Null
Start-Sleep -Seconds 10
$memFlutter = (adb -s $DeviceId shell dumpsys meminfo com.example.app) | Out-String
$flutterMem = Parse-Mem $memFlutter

Write-Host "`n--- Memory Footprint Summary (PSS) ---" -ForegroundColor Green
Write-Host "Zero-Native:"
Write-Host "  Native Heap: $([math]::Round($znMem.Native / 1024, 1)) MB ($($znMem.Native) KB)"
Write-Host "  Dalvik Heap: $([math]::Round($znMem.Java / 1024, 1)) MB ($($znMem.Java) KB)"
Write-Host "  TOTAL PSS:   $([math]::Round($znMem.Total / 1024, 1)) MB ($($znMem.Total) KB)" -ForegroundColor Cyan

Write-Host "`nReact Native Staging:"
Write-Host "  Native Heap: $([math]::Round($rnMem.Native / 1024, 1)) MB ($($rnMem.Native) KB)"
Write-Host "  Dalvik Heap: $([math]::Round($rnMem.Java / 1024, 1)) MB ($($rnMem.Java) KB)"
Write-Host "  TOTAL PSS:   $([math]::Round($rnMem.Total / 1024, 1)) MB ($($rnMem.Total) KB)" -ForegroundColor Yellow

Write-Host "`nFlutter Legacy:"
Write-Host "  Native Heap: $([math]::Round($flutterMem.Native / 1024, 1)) MB ($($flutterMem.Native) KB)"
Write-Host "  Dalvik Heap: $([math]::Round($flutterMem.Java / 1024, 1)) MB ($($flutterMem.Java) KB)"
Write-Host "  TOTAL PSS:   $([math]::Round($flutterMem.Total / 1024, 1)) MB ($($flutterMem.Total) KB)" -ForegroundColor Yellow

$rnSaving = [math]::Round((1 - ($znMem.Total / $rnMem.Total)) * 100, 1)
$flutterSaving = [math]::Round((1 - ($znMem.Total / $flutterMem.Total)) * 100, 1)
Write-Host "`nMemory Savings vs React Native: $rnSaving% reduction (-$([math]::Round(($rnMem.Total - $znMem.Total)/1024, 1)) MB)" -ForegroundColor Green
Write-Host "Memory Savings vs Flutter:      $flutterSaving% reduction (-$([math]::Round(($flutterMem.Total - $znMem.Total)/1024, 1)) MB)" -ForegroundColor Green

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "                BENCHMARK COMPLETE                        " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

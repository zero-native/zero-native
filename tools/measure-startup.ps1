# Cold start timing: force-stop, `am start -W`, read TotalTime. Repeats and prints median / p90.
# The first run is left out (docs/startup-and-performance.md §2).
#
#   .\tools\measure-startup.ps1                       # 11 runs of the sample, current compiled state
#   .\tools\measure-startup.ps1 -Compile verify       # first reset to "no AOT code" (JIT only)
#   .\tools\measure-startup.ps1 -Compile speed-profile  # AOT-compile what the installed profile lists
#
# -Compile runs `cmd package compile -f -m <mode>` once before measuring. Use only on release builds.
param(
    [string]$Package = "dev.zeronative.sample",
    [string]$Activity = ".MainActivity",
    [int]$Runs = 11,
    [string]$Compile = ""
)
$ErrorActionPreference = 'Continue'

adb wait-for-device
$flags = adb shell dumpsys package $Package | Select-String "pkgFlags="
if ("$flags" -match "DEBUGGABLE") { Write-Warning "$Package is a debug build; these numbers are not comparable." }

if ($Compile -ne "") {
    adb shell cmd package compile -f -m $Compile $Package | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Error "compile failed"; exit 1 }
    Write-Host "compiled with -m $Compile"
}

$times = @()
for ($i = 0; $i -lt $Runs; $i++) {
    adb shell am force-stop $Package
    Start-Sleep -Milliseconds 800
    $out = adb shell am start -W -n "$Package/$Activity"
    $line = $out | Select-String "TotalTime:"
    if ($null -eq $line) { Write-Warning "run $i : no TotalTime"; continue }
    $ms = [int](("$line" -split ":")[1].Trim())
    $times += $ms
    Start-Sleep -Milliseconds 1500
}
adb shell am force-stop $Package

if ($times.Count -lt 2) { Write-Error "not enough runs"; exit 1 }
$kept = $times[1..($times.Count - 1)] | Sort-Object
$median = $kept[[int][math]::Floor(($kept.Count - 1) / 2)]
$p90 = $kept[[int][math]::Ceiling(0.9 * $kept.Count) - 1]
Write-Host ("all runs (ms): " + ($times -join ", "))
Write-Host ("first run dropped; n={0}  min={1}  median={2}  p90={3}  max={4}" -f $kept.Count, $kept[0], $median, $p90, $kept[-1])

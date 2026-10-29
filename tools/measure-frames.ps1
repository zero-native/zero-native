# Frame times while flinging a feed, the same way for any app (zero-native sample, the RN app, Flutter app), so the
# numbers compare fairly (docs/startup-and-performance.md §2–3). Release builds only.
#
# 1. Open the screen to measure on the phone (e.g. the RN app's Offers tab, or zn://sample/offers) and leave it at
#    the top.
# 2. Run:  .\tools\measure-frames.ps1 -Package com.example.app
#    (-RailY = the y pixel of a horizontal rail to swipe sideways; default 1000 fits the Lava's offers screens.)
#
# The script does 20 fast flings down, 6 sideways flings on the rail, 8 flings back up, then prints dumpsys gfxinfo
# (frame percentiles, janky frames) and memory. Run it 2–3 times per app; note the phone's load (printed first).
param(
    [Parameter(Mandatory = $true)][string]$Package,
    [int]$Down = 20,
    [int]$Sideways = 6,
    [int]$Up = 8,
    [int]$RailY = 1000
)
$ErrorActionPreference = 'Continue'

adb wait-for-device
$flags = adb shell dumpsys package $Package | Select-String "pkgFlags="
if ("$flags" -match "DEBUGGABLE") { Write-Warning "$Package is a debug build; these numbers are not comparable." }
$size = (adb shell wm size) -replace '.*: ', ''
$w, $h = $size.Trim().Split('x') | ForEach-Object { [int]$_ }
$x = [int]($w / 2)
$top = [int]($h * 0.15)
$bottom = [int]($h * 0.85)
Write-Host ("phone load: " + (adb shell uptime))

adb shell dumpsys gfxinfo $Package reset | Out-Null
for ($i = 0; $i -lt $Down; $i++) { adb shell input swipe $x $bottom $x $top 45 }
for ($i = 0; $i -lt $Sideways; $i++) { adb shell input swipe ([int]($w * 0.9)) $RailY ([int]($w * 0.1)) $RailY 60 }
for ($i = 0; $i -lt $Up; $i++) { adb shell input swipe $x $top $x $bottom 45 }
Start-Sleep -Seconds 1

adb shell dumpsys gfxinfo $Package |
    Select-String "Total frames|^Janky frames|percentile|Missed Vsync|Slow UI thread|Slow bitmap|Frame deadline missed" |
    Select-Object -First 12 | ForEach-Object { $_.Line.Trim() }
adb shell dumpsys meminfo $Package | Select-String "TOTAL PSS" | Select-Object -First 1 | ForEach-Object { $_.Line.Trim() }

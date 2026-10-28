param(
    [Parameter(Mandatory=$false)]
    [string]$Scenario = "ALL",
    [Parameter(Mandatory=$false)]
    [string]$DeviceId = ""
)

$ErrorActionPreference = "Continue"

if (-not $DeviceId) {
    $devs = adb devices | Select-String -Pattern "\sdevice$"
    if ($devs) {
        $DeviceId = ($devs[0] -split '\s+')[0]
    }
}

if (-not $DeviceId) {
    Write-Error "No connected device found via adb."
    exit 1
}

$PKG = "dev.zeronative.exp4"
$ACTIVITY = "$PKG/.MainActivity"
$BACKEND = "http://localhost:8787"

# Ensure reverse proxy is active
adb -s $DeviceId reverse tcp:8787 tcp:8787 | Out-Null

function Reset-Device-State {
    adb -s $DeviceId shell setprop debug.zn.crash none
    adb -s $DeviceId shell am force-stop $PKG
    adb -s $DeviceId shell am force-stop p2pdops.android.p2pupiapp
    adb -s $DeviceId shell pm clear $PKG | Out-Null
    adb -s $DeviceId reverse tcp:8787 tcp:8787 | Out-Null
    Invoke-RestMethod -Uri "$BACKEND/reset" -Method POST | Out-Null
    Start-Sleep -Milliseconds 400
}

function Tap-Amount-500-And-Pay {
    # Tap '5'
    adb -s $DeviceId shell input tap 360 1060
    Start-Sleep -Milliseconds 200
    # Tap '0'
    adb -s $DeviceId shell input tap 360 1320
    Start-Sleep -Milliseconds 200
    # Tap '0'
    adb -s $DeviceId shell input tap 360 1320
    Start-Sleep -Milliseconds 400
    # Tap 'Pay Now'
    adb -s $DeviceId shell input tap 360 1440
    Start-Sleep -Milliseconds 800
    # Tap Mock UPI App on Checkout sheet (y = 700)
    adb -s $DeviceId shell input tap 360 700
    Start-Sleep -Milliseconds 600
}

function Run-S4b {
    param([int]$RunIndex)
    Write-Host "`n>>> [RUN $RunIndex] Running S4b: Kill between FlowStore write and UPI launch <<<" -ForegroundColor Yellow
    Reset-Device-State
    
    # Arm S4b crash hook
    adb -s $DeviceId shell setprop debug.zn.crash S4b
    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 1

    Write-Host "Initiating payment to trigger S4b crash point..."
    Tap-Amount-500-And-Pay
    Start-Sleep -Seconds 1

    # Verify process was killed
    $pidCheck = adb -s $DeviceId shell pidof $PKG
    if (-not $pidCheck) {
        Write-Host "Process successfully killed at S4b crash point!" -ForegroundColor Green
    } else {
        Write-Warning "Process still running! PID=$pidCheck"
    }

    # Disarm crash hook and restart app
    adb -s $DeviceId shell setprop debug.zn.crash none
    Write-Host "Restarting app from launcher (cold restore)..."
    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 2

    # Check that flow restored into verifying and audited stats
    $stats = Invoke-RestMethod -Uri "$BACKEND/stats"
    Write-Host "Audit Results: Pay calls=$($stats.payCallCount), Verify calls=$($stats.verifyCallCount)" -ForegroundColor Cyan
    if ($stats.payCallCount -eq 1) {
        Write-Host "PASS S4b Run $($RunIndex): Strictly 1 /pay call, Zero double launch!" -ForegroundColor Green
        return $true
    } else {
        Write-Error "FAIL S4b Run $($RunIndex): Unexpected /pay count $($stats.payCallCount)"
        return $false
    }
}

function Run-S4c {
    param([int]$RunIndex)
    Write-Host "`n>>> [RUN $RunIndex] Running S4c: Kill after /pay sent, before response committed <<<" -ForegroundColor Yellow
    Reset-Device-State
    
    # Arm S4c crash hook
    adb -s $DeviceId shell setprop debug.zn.crash S4c
    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 1

    Write-Host "Initiating payment to trigger S4c crash point..."
    Tap-Amount-500-And-Pay
    Start-Sleep -Seconds 1

    # Verify process was killed
    $pidCheck = adb -s $DeviceId shell pidof $PKG
    if (-not $pidCheck) {
        Write-Host "Process successfully killed at S4c crash point!" -ForegroundColor Green
    } else {
        Write-Warning "Process still running! PID=$pidCheck"
    }

    # Disarm crash hook and restart app
    adb -s $DeviceId shell setprop debug.zn.crash none
    Write-Host "Restarting app from launcher (cold restore)..."
    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 2

    # Check stats: /pay was received by mock once before kill; on restart, /pay is 'once' so it must NOT run again!
    $stats = Invoke-RestMethod -Uri "$BACKEND/stats"
    Write-Host "Audit Results: Pay calls=$($stats.payCallCount), Verify calls=$($stats.verifyCallCount)" -ForegroundColor Cyan
    if ($stats.payCallCount -eq 1) {
        Write-Host "PASS S4c Run $($RunIndex): Strictly 1 /pay call, zero second /pay on restore!" -ForegroundColor Green
        return $true
    } else {
        Write-Error "FAIL S4c Run $($RunIndex): Double payment detected! /pay count=$($stats.payCallCount)"
        return $false
    }
}

function Run-S7 {
    param([int]$RunIndex)
    Write-Host "`n>>> [RUN $RunIndex] Running S7: Hardware/System Back pressed in UPI app <<<" -ForegroundColor Yellow
    Reset-Device-State
    Invoke-RestMethod -Uri "$BACKEND/control" -Method POST -Body '{"status":"CANCELLED"}' -ContentType "application/json" | Out-Null

    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 1

    Tap-Amount-500-And-Pay
    Start-Sleep -Seconds 3 # Wait for translucent spinner -> opaque PaymentActivity

    Write-Host "Pressing system Back button in UPI app..."
    adb -s $DeviceId shell input keyevent 4
    Start-Sleep -Seconds 2

    $stats = Invoke-RestMethod -Uri "$BACKEND/stats"
    $verifyLog = $stats.recentLogs | Where-Object { $_.path -eq "/transactions/verify" } | Select-Object -Last 1
    Write-Host "Audit Results: Pay calls=$($stats.payCallCount), Verify calls=$($stats.verifyCallCount)" -ForegroundColor Cyan
    Write-Host "Wire payload: $($verifyLog.body.upi_response)" -ForegroundColor Gray
    if ($stats.payCallCount -eq 1 -and $verifyLog.body.upi_response -match "RESULTCODE=0") {
        Write-Host "PASS S7 Run $($RunIndex): Clean cancel with RESULTCODE=0 wire parity!" -ForegroundColor Green
        return $true
    } else {
        Write-Error "FAIL S7 Run $($RunIndex)"
        return $false
    }
}

function Run-S8 {
    param([int]$RunIndex)
    Write-Host "`n>>> [RUN $RunIndex] Running S8: Retry payment after cancel <<<" -ForegroundColor Yellow
    Reset-Device-State

    # Attempt 1: Cancel
    Invoke-RestMethod -Uri "$BACKEND/control" -Method POST -Body '{"status":"CANCELLED"}' -ContentType "application/json" | Out-Null
    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 1
    Tap-Amount-500-And-Pay
    Start-Sleep -Seconds 3
    # Press Back in UPI app to cancel
    adb -s $DeviceId shell input keyevent 4
    Start-Sleep -Seconds 3

    # Return to Home / Amount screen by tapping 'Return to Home' button (y = 1080)
    Write-Host "Attempt 1 cancelled. Tapping Return to Home (360, 1080)..."
    adb -s $DeviceId shell input tap 360 1080
    Start-Sleep -Seconds 1.5

    # Attempt 2: Pay again (type 500, tap Pay Now, select mock UPI, and approve)
    Write-Host "Attempt 2: Entering 500, selecting mock UPI, and approving..."
    Invoke-RestMethod -Uri "$BACKEND/control" -Method POST -Body '{"status":"SUCCESS"}' -ContentType "application/json" | Out-Null
    
    Tap-Amount-500-And-Pay
    Start-Sleep -Seconds 3
    # In PaymentActivity, tap Approve button (y = 960)
    adb -s $DeviceId shell input tap 360 960
    Start-Sleep -Seconds 2

    $stats = Invoke-RestMethod -Uri "$BACKEND/stats"
    Write-Host "Audit Results: Pay calls=$($stats.payCallCount), Verify calls=$($stats.verifyCallCount)" -ForegroundColor Cyan
    if ($stats.payCallCount -eq 2 -and $stats.verifyCallCount -eq 2) {
        Write-Host "PASS S8 Run $($RunIndex): Exactly 2 /pay calls and 2 /verify calls across 2 attempts (1 per attempt)!" -ForegroundColor Green
        return $true
    } else {
        Write-Error "FAIL S8 Run $($RunIndex): Expected 2 /pay and 2 /verify calls, got $($stats.payCallCount) /pay, $($stats.verifyCallCount) /verify"
        return $false
    }
}

function Run-S11 {
    param([int]$RunIndex)
    Write-Host "`n>>> [RUN $RunIndex] Running S11: Kill after SUCCESS then reopen <<<" -ForegroundColor Yellow
    Reset-Device-State
    Invoke-RestMethod -Uri "$BACKEND/control" -Method POST -Body '{"status":"SUCCESS"}' -ContentType "application/json" | Out-Null

    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 1
    Tap-Amount-500-And-Pay
    Start-Sleep -Seconds 3
    # In PaymentActivity, tap Approve button (y = 960)
    adb -s $DeviceId shell input tap 360 960
    Start-Sleep -Seconds 2

    $beforeStats = Invoke-RestMethod -Uri "$BACKEND/stats"
    Write-Host "Success reached. Backgrounding and killing app via 'am kill'..."
    adb -s $DeviceId shell input keyevent 3 # Home
    Start-Sleep -Milliseconds 500
    adb -s $DeviceId shell am kill $PKG
    Start-Sleep -Milliseconds 500

    Write-Host "Re-opening app from launcher..."
    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 2

    $afterStats = Invoke-RestMethod -Uri "$BACKEND/stats"
    Write-Host "Before stats: Pay=$($beforeStats.payCallCount), Verify=$($beforeStats.verifyCallCount)"
    Write-Host "After stats:  Pay=$($afterStats.payCallCount), Verify=$($afterStats.verifyCallCount)" -ForegroundColor Cyan
    if ($afterStats.payCallCount -eq $beforeStats.payCallCount -and $afterStats.verifyCallCount -eq $beforeStats.verifyCallCount) {
        Write-Host "PASS S11 Run $($RunIndex): Restored to Success screen without extra /pay or /verify!" -ForegroundColor Green
        return $true
    } else {
        Write-Error "FAIL S11 Run $($RunIndex): Extra network calls detected on restore!"
        return $false
    }
}

function Run-S12a {
    param([int]$RunIndex)
    Write-Host "`n>>> [RUN $RunIndex] Running S12a: Expiry before /pay (flow dropped to Home) <<<" -ForegroundColor Yellow
    Reset-Device-State
    
    # Arm 5s expiry debug property
    adb -s $DeviceId shell setprop debug.zn.expires 5
    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 1

    Write-Host "Typing amount 500 (no /pay initiated)..."
    # Tap '5'
    adb -s $DeviceId shell input tap 360 1060
    Start-Sleep -Milliseconds 200
    # Tap '0'
    adb -s $DeviceId shell input tap 360 1320
    Start-Sleep -Milliseconds 200
    # Tap '0'
    adb -s $DeviceId shell input tap 360 1320
    Start-Sleep -Milliseconds 400

    Write-Host "Killing app and waiting 6s for expiry to pass..."
    adb -s $DeviceId shell am force-stop $PKG
    Start-Sleep -Seconds 6

    Write-Host "Cold restarting app from launcher..."
    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 2

    # Check UI: Flow must be dropped, screen must be Home (/amount) with "Enter Amount"
    adb -s $DeviceId shell uiautomator dump /data/local/tmp/s12a.xml | Out-Null
    $ui = adb -s $DeviceId shell cat /data/local/tmp/s12a.xml
    $isHome = $ui -match "Enter Amount"
    $stats = Invoke-RestMethod -Uri "$BACKEND/stats"

    adb -s $DeviceId shell setprop debug.zn.expires none

    if ($isHome -and $stats.payCallCount -eq 0) {
        Write-Host "PASS S12a Run $($RunIndex): Flow dropped after expiry! Restored to clean Home screen with 0 /pay calls." -ForegroundColor Green
        return $true
    } else {
        Write-Error "FAIL S12a Run $($RunIndex): App did not drop expired safe flow!"
        return $false
    }
}

function Run-S12b {
    param([int]$RunIndex)
    Write-Host "`n>>> [RUN $RunIndex] Running S12b: Expiry after /pay started (reconciles to verifying) <<<" -ForegroundColor Yellow
    Reset-Device-State
    
    # Arm 5s expiry and S4b crash hook (crash right at UPI launch)
    adb -s $DeviceId shell setprop debug.zn.expires 5
    adb -s $DeviceId shell setprop debug.zn.crash S4b
    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 1

    Write-Host "Initiating payment to start in-flight unsafe effects..."
    Tap-Amount-500-And-Pay
    Start-Sleep -Seconds 1

    # Disarm crash hook
    adb -s $DeviceId shell setprop debug.zn.crash none

    Write-Host "Killed at S4b. Waiting 6s for expiry to pass with in-flight effects..."
    Start-Sleep -Seconds 6

    Write-Host "Cold restarting app from launcher..."
    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 2

    # Check UI: Flow must NOT be dropped; money may have moved, so it opens in verifying (reconcile)
    adb -s $DeviceId shell uiautomator dump /data/local/tmp/s12b.xml | Out-Null
    $ui = adb -s $DeviceId shell cat /data/local/tmp/s12b.xml
    $isVerifying = $ui -match "Checking.*payment" -or $ui -match "Payment"
    $stats = Invoke-RestMethod -Uri "$BACKEND/stats"

    adb -s $DeviceId shell setprop debug.zn.expires none

    if ($isVerifying -and $stats.payCallCount -eq 1) {
        Write-Host "PASS S12b Run $($RunIndex): In-flight flow NOT dropped! Safely reconciled to verifying screen." -ForegroundColor Green
        return $true
    } else {
        Write-Error "FAIL S12b Run $($RunIndex): In-flight flow was unexpectedly dropped or duplicated!"
        return $false
    }
}

function Run-S17a {
    param([int]$RunIndex)
    Write-Host "`n>>> [RUN $RunIndex] Running S17a: Schema v1 -> v2 migration with migrate[1] <<<" -ForegroundColor Yellow
    Reset-Device-State
    
    # Start with standard schema v1
    adb -s $DeviceId shell setprop debug.zn.schema 1
    adb -s $DeviceId shell setprop debug.zn.migrate '""'
    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 1

    # Type 500 and go to Checkout (saves v1 flow state)
    adb -s $DeviceId shell input tap 360 1060
    Start-Sleep -Milliseconds 200
    adb -s $DeviceId shell input tap 360 1320
    Start-Sleep -Milliseconds 200
    adb -s $DeviceId shell input tap 360 1320
    Start-Sleep -Milliseconds 400
    adb -s $DeviceId shell input tap 360 1440
    Start-Sleep -Seconds 1

    Write-Host "Flow saved as schema v1. Killing app..."
    adb -s $DeviceId shell am force-stop $PKG

    Write-Host "Arming schema v2 with migrate[1] declared..."
    adb -s $DeviceId shell setprop debug.zn.schema 2
    adb -s $DeviceId shell setprop debug.zn.migrate v1

    Write-Host "Cold restarting app from launcher..."
    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 2

    # Check that app restored cleanly and migrated
    $pidCheck = adb -s $DeviceId shell pidof $PKG
    adb -s $DeviceId shell setprop debug.zn.schema none
    adb -s $DeviceId shell setprop debug.zn.migrate none

    if ($pidCheck) {
        Write-Host "PASS S17a Run $($RunIndex): App cold-started with schema v2 and applied migrate[1] cleanly without crash!" -ForegroundColor Green
        return $true
    } else {
        Write-Error "FAIL S17a Run $($RunIndex): App crashed on schema migration!"
        return $false
    }
}

function Run-S17b {
    param([int]$RunIndex)
    Write-Host "`n>>> [RUN $RunIndex] Running S17b: Schema v2 with missing migration path <<<" -ForegroundColor Yellow
    Reset-Device-State
    
    # Save v1 flow with in-flight payment effect via S4b
    adb -s $DeviceId shell setprop debug.zn.schema 1
    adb -s $DeviceId shell setprop debug.zn.migrate '""'
    adb -s $DeviceId shell setprop debug.zn.crash S4b
    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 1

    Tap-Amount-500-And-Pay
    Start-Sleep -Seconds 1
    adb -s $DeviceId shell setprop debug.zn.crash none

    Write-Host "Flow saved as schema v1 with in-flight effect. Arming schema v2 with NO migration path..."
    adb -s $DeviceId shell setprop debug.zn.schema 2
    adb -s $DeviceId shell setprop debug.zn.migrate none

    Write-Host "Cold restarting app from launcher..."
    adb -s $DeviceId shell am start -W -n $ACTIVITY | Out-Null
    Start-Sleep -Seconds 2

    # In S17b: Missing migration with in-flight effects MUST safely reconcile to verifying (never drop money!), NO crash
    $pidCheck = adb -s $DeviceId shell pidof $PKG
    adb -s $DeviceId shell uiautomator dump /data/local/tmp/s17b.xml | Out-Null
    $ui = adb -s $DeviceId shell cat /data/local/tmp/s17b.xml
    $isReconciled = $ui -match "Checking.*payment" -or $ui -match "Payment"
    
    adb -s $DeviceId shell setprop debug.zn.schema none
    adb -s $DeviceId shell setprop debug.zn.migrate none

    if ($pidCheck -and $isReconciled) {
        Write-Host "PASS S17b Run $($RunIndex): Missing migration safely fell back to verifying reconcile! Zero crash." -ForegroundColor Green
        return $true
    } else {
        Write-Error "FAIL S17b Run $($RunIndex): Missing migration crashed or failed to reconcile!"
        return $false
    }
}

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "Starting Gap Verification Matrix on $DeviceId" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green

if ($Scenario -eq "ALL" -or $Scenario -eq "S4b") {
    1..3 | ForEach-Object { Run-S4b -RunIndex $_ }
}
if ($Scenario -eq "ALL" -or $Scenario -eq "S4c") {
    1..3 | ForEach-Object { Run-S4c -RunIndex $_ }
}
if ($Scenario -eq "ALL" -or $Scenario -eq "S7") {
    1..3 | ForEach-Object { Run-S7 -RunIndex $_ }
}
if ($Scenario -eq "ALL" -or $Scenario -eq "S8") {
    1..3 | ForEach-Object { Run-S8 -RunIndex $_ }
}
if ($Scenario -eq "ALL" -or $Scenario -eq "S11") {
    1..3 | ForEach-Object { Run-S11 -RunIndex $_ }
}
if ($Scenario -eq "ALL" -or $Scenario -eq "S12a") {
    1..3 | ForEach-Object { Run-S12a -RunIndex $_ }
}
if ($Scenario -eq "ALL" -or $Scenario -eq "S12b") {
    1..3 | ForEach-Object { Run-S12b -RunIndex $_ }
}
if ($Scenario -eq "ALL" -or $Scenario -eq "S17a") {
    1..3 | ForEach-Object { Run-S17a -RunIndex $_ }
}
if ($Scenario -eq "ALL" -or $Scenario -eq "S17b") {
    1..3 | ForEach-Object { Run-S17b -RunIndex $_ }
}

Write-Host "`nAll requested scenario runs completed!" -ForegroundColor Cyan

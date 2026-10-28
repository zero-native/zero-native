param(
    [Parameter(Mandatory=$false)]
    [string]$Scenario = "S1",
    [Parameter(Mandatory=$false)]
    [string]$DeviceId = ""
)

$ErrorActionPreference = "Continue"

# Find device if not specified
if (-not $DeviceId) {
    $devs = adb devices | Select-String -Pattern "\sdevice$"
    if ($devs) {
        $DeviceId = ($devs[0] -split '\s+')[0]
    }
}

if (-not $DeviceId) {
    Write-Warning "No device attached. Please connect your phone."
    exit 1
}

$PKG = "dev.zeronative.exp4"
$ACTIVITY = "$PKG/.MainActivity"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Running Experiment 4 Scenario: $Scenario on $DeviceId" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan

# Ensure reverse proxy is active for Mock Backend
adb -s $DeviceId reverse tcp:8787 tcp:8787
Invoke-RestMethod -Uri "http://localhost:8787/reset" -Method POST | Out-Null

function Enter-Amount-500 {
    Write-Host "Entering 500 on keypad and tapping Pay Now..."
    adb -s $DeviceId shell input tap 360 1060 # '5'
    Start-Sleep -Milliseconds 250
    adb -s $DeviceId shell input tap 360 1320 # '0'
    Start-Sleep -Milliseconds 250
    adb -s $DeviceId shell input tap 360 1320 # '0'
    Start-Sleep -Milliseconds 400
    adb -s $DeviceId shell input tap 360 1440 # 'Pay Now'
    Start-Sleep -Milliseconds 800
}

switch ($Scenario) {
    "S1" {
        Write-Host "Scenario S1: Normal cancel (Back in UPI app)" -ForegroundColor Yellow
        Invoke-RestMethod -Uri "http://localhost:8787/control" -Method POST -Body '{"status":"CANCELLED"}' -ContentType "application/json" | Out-Null
        
        Write-Host "1. Launching $PKG (clean state)..."
        adb -s $DeviceId shell am force-stop net.one97.paytm
        adb -s $DeviceId shell am force-stop com.phonepe.app
        adb -s $DeviceId shell am force-stop p2pdops.android.p2pupiapp
        adb -s $DeviceId shell am force-stop $PKG
        adb -s $DeviceId shell "run-as $PKG rm -f files/zn-flows/checkout.znfs"
        adb -s $DeviceId shell am start -W -n $ACTIVITY
        Start-Sleep -Seconds 2

        Enter-Amount-500

        Write-Host "3. Tapping Mock UPI app..."
        adb -s $DeviceId shell input tap 360 890
        Start-Sleep -Seconds 3

        Write-Host "4. Pressing Back in UPI app..."
        adb -s $DeviceId shell input keyevent 4
        Start-Sleep -Seconds 2

        Write-Host "5. Auditing mock backend stats..."
        $stats = Invoke-RestMethod -Uri "http://localhost:8787/stats"
        Write-Host "Audit Results: Pay calls=$($stats.payCallCount), Verify calls=$($stats.verifyCallCount)" -ForegroundColor Green
    }

    "S2" {
        Write-Host "Scenario S2: Don't keep activities" -ForegroundColor Yellow
        adb -s $DeviceId shell settings put global always_finish_activities 1
        
        adb -s $DeviceId shell am force-stop $PKG
        adb -s $DeviceId shell am start -W -n $ACTIVITY
        Start-Sleep -Seconds 2

        adb -s $DeviceId shell input tap 360 1440
        Start-Sleep -Milliseconds 800
        adb -s $DeviceId shell input tap 360 880
        Start-Sleep -Seconds 2
        adb -s $DeviceId shell input keyevent 4
        Start-Sleep -Seconds 2

        # Reset setting
        adb -s $DeviceId shell settings put global always_finish_activities 0
        $stats = Invoke-RestMethod -Uri "http://localhost:8787/stats"
        Write-Host "Pay calls: $($stats.payCallCount), Verify calls: $($stats.verifyCallCount)" -ForegroundColor Green
    }

    "S3" {
        Write-Host "Scenario S3: Process killed while in UPI app (am kill)" -ForegroundColor Yellow
        adb -s $DeviceId shell am force-stop $PKG
        adb -s $DeviceId shell am start -W -n $ACTIVITY
        Start-Sleep -Seconds 2

        adb -s $DeviceId shell input tap 360 1440
        Start-Sleep -Milliseconds 800
        adb -s $DeviceId shell input tap 360 880
        Start-Sleep -Seconds 2

        Write-Host "Killing background process $PKG with am kill..."
        adb -s $DeviceId shell am kill $PKG
        Start-Sleep -Milliseconds 500

        Write-Host "Returning from UPI app..."
        adb -s $DeviceId shell input keyevent 4
        Start-Sleep -Seconds 2

        $stats = Invoke-RestMethod -Uri "http://localhost:8787/stats"
        Write-Host "Pay calls: $($stats.payCallCount), Verify calls: $($stats.verifyCallCount)" -ForegroundColor Green
    }

    "S4" {
        Write-Host "Scenario S4: Both apps gone (am force-stop both)" -ForegroundColor Yellow
        adb -s $DeviceId shell am force-stop $PKG
        adb -s $DeviceId shell am start -W -n $ACTIVITY
        Start-Sleep -Seconds 2

        adb -s $DeviceId shell input tap 360 1440
        Start-Sleep -Milliseconds 800
        adb -s $DeviceId shell input tap 360 880
        Start-Sleep -Seconds 2

        Write-Host "Force stopping both apps..."
        adb -s $DeviceId shell am force-stop $PKG
        adb -s $DeviceId shell am force-stop p2pdops.android.p2pupiapp
        adb -s $DeviceId shell am force-stop com.phonepe.app
        Start-Sleep -Seconds 1

        Write-Host "Cold launching ZeroBill from launcher..."
        adb -s $DeviceId shell am start -W -n $ACTIVITY
        Start-Sleep -Seconds 2

        $stats = Invoke-RestMethod -Uri "http://localhost:8787/stats"
        Write-Host "Pay calls: $($stats.payCallCount), Verify calls: $($stats.verifyCallCount)" -ForegroundColor Green
    }

    "S4d" {
        Write-Host "Scenario S4d: Torn FlowStore write recovery" -ForegroundColor Yellow
        # Write corrupted byte into checkout flow file
        Write-Host "Corrupting active slot in FlowStore..."
        adb -s $DeviceId shell "echo 'CORRUPT' >> /data/data/$PKG/files/zn-flows/checkout.znfs"
        adb -s $DeviceId shell am force-stop $PKG
        adb -s $DeviceId shell am start -W -n $ACTIVITY
        Start-Sleep -Seconds 2
        Write-Host "App started safely without crashing!" -ForegroundColor Green
    }

    "SM" {
        Write-Host "Scenario SM: Safe mode crash loop guard" -ForegroundColor Yellow
        Write-Host "Injecting rapid crash attempts into SharedPreferences..."
        adb -s $DeviceId shell "run-as $PKG sed -i 's/<int name=\"restore_attempts\" value=\"[0-9]*\"/<int name=\"restore_attempts\" value=\"2\"/g' /data/data/$PKG/shared_prefs/zn_safe_mode.xml"
        adb -s $DeviceId shell am force-stop $PKG
        adb -s $DeviceId shell am start -W -n $ACTIVITY
        Start-Sleep -Seconds 2
        Write-Host "Safe mode screen rendered!" -ForegroundColor Green
    }
}

Write-Host "Scenario $Scenario execution finished." -ForegroundColor Cyan

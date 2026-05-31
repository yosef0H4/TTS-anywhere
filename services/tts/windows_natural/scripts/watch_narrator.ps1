param(
    [string]$OutputRoot = ".analysis\narrator-watch",
    [string]$TraceName = "NarratorWatchTrace",
    [string]$TargetText = "Welcome to Narrator",
    [int]$MaxEvents = 200
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Write-JsonFile {
    param(
        [string]$Path,
        [object]$Value
    )

    $dir = Split-Path -Parent $Path
    if ($dir) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $Value | ConvertTo-Json -Depth 8 | Set-Content -Path $Path -Encoding UTF8
}

function Clear-OutputRoot {
    param(
        [string]$Path
    )

    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    Get-ChildItem -Path $Path -Force -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

function Invoke-NativeCommandCapture {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [bool]$AllowFailure = $false
    )

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()
    try {
        $process = Start-Process -FilePath $FilePath `
            -ArgumentList $ArgumentList `
            -Wait `
            -NoNewWindow `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath

        $stdout = if (Test-Path $stdoutPath) { (Get-Content -Raw -Path $stdoutPath) } else { "" }
        $stderr = if (Test-Path $stderrPath) { (Get-Content -Raw -Path $stderrPath) } else { "" }
        if ($null -eq $stdout) { $stdout = "" }
        if ($null -eq $stderr) { $stderr = "" }

        $result = @{
            success = ($process.ExitCode -eq 0)
            exit_code = $process.ExitCode
            stdout = $stdout.Trim()
            stderr = $stderr.Trim()
        }

        if (-not $result.success -and -not $AllowFailure) {
            throw ("Command failed: {0} {1}`n{2}" -f $FilePath, ($ArgumentList -join " "), $result.stderr)
        }

        return $result
    } finally {
        Remove-Item $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-AppxSummary {
    Get-AppxPackage |
        Where-Object {
            $_.Name -like "MicrosoftWindows.Voice.*" -or
            $_.Name -in @(
                "MicrosoftWindows.60719896.Speion",
                "MicrosoftWindows.Client.Core",
                "MicrosoftWindows.Client.CoreAI"
            )
        } |
        Select-Object Name, PackageFamilyName, PackageFullName, Version, InstallLocation
}

function Get-NarratorSnapshot {
    $processes = @(Get-Process Narrator -ErrorAction SilentlyContinue |
        Select-Object Id, ProcessName, StartTime, Responding, Path)

    $registry = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Narrator\NoRoam" -ErrorAction SilentlyContinue

    return @{
        timestamp_utc = [DateTime]::UtcNow.ToString("o")
        narrator_processes = $processes
        narrator_registry = if ($registry) {
            @{
                SpeechVoice = $registry.SpeechVoice
                RunningState = $registry.RunningState
            }
        } else {
            $null
        }
    }
}

function Get-TargetProviders {
    return @(
        "Microsoft-Windows-Narrator",
        "Microsoft-Windows-Speech-TTS",
        "Microsoft-Windows-Speech-UserExperience",
        "Microsoft-Windows-AppModel-Exec",
        "Microsoft-Windows-AppModel-Runtime",
        "Microsoft-Windows-AppXDeployment",
        "Microsoft-Windows-BrokerInfrastructure",
        "Microsoft-Windows-COM",
        "Microsoft-Windows-COMRuntime",
        "Microsoft-Windows-Shell-Core",
        "Microsoft-Windows-WinRT-Error"
    )
}

function Ensure-NarratorRunning {
    $existing = @(Get-Process Narrator -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        return @{
            started = $false
            pids = @($existing | ForEach-Object { $_.Id })
        }
    }

    Start-Process -FilePath "C:\Windows\System32\Narrator.exe"
    Start-Sleep -Seconds 2
    $started = @(Get-Process Narrator -ErrorAction SilentlyContinue)
    return @{
        started = $true
        pids = @($started | ForEach-Object { $_.Id })
    }
}

function Stop-TraceSession {
    param(
        [string]$Name
    )

    $stop = Invoke-NativeCommandCapture -FilePath "logman.exe" -ArgumentList @("stop", $Name, "-ets") -AllowFailure $true
    $delete = Invoke-NativeCommandCapture -FilePath "logman.exe" -ArgumentList @("delete", $Name, "-ets") -AllowFailure $true
    return @{
        stop = $stop
        delete = $delete
    }
}

function Start-TraceSession {
    param(
        [string]$Name,
        [string]$EtlPath,
        [string]$ProviderFilePath
    )

    $null = Stop-TraceSession -Name $Name

    $args = @(
        "create", "trace", $Name,
        "-ow",
        "-o", $EtlPath,
        "-ets",
        "-f", "bin",
        "-max", "1024",
        "-bs", "1024",
        "-nb", "16", "64",
        "-pf", $ProviderFilePath
    )

    return Invoke-NativeCommandCapture -FilePath "logman.exe" -ArgumentList $args -AllowFailure $true
}

function Get-InterestingEvents {
    param(
        [string]$EtlPath,
        [string[]]$Providers,
        [int]$Limit
    )

    if (-not (Test-Path $EtlPath)) {
        return @{
            total = 0
            by_provider = @()
            sample = @()
            error = "etl_missing"
        }
    }

    try {
        $events = @(Get-WinEvent -Path $EtlPath -Oldest -ErrorAction Stop |
            Where-Object { $_.ProviderName -in $Providers } |
            Select-Object -First $Limit)

        $sample = @($events | ForEach-Object {
            @{
                time_created = if ($_.TimeCreated) { $_.TimeCreated.ToUniversalTime().ToString("o") } else { $null }
                provider = $_.ProviderName
                id = $_.Id
                level = $_.LevelDisplayName
                opcode = $_.OpcodeDisplayName
                task = $_.TaskDisplayName
                process_id = $_.ProcessId
                thread_id = $_.ThreadId
                message = if ($_.Message) { ($_.Message -replace "\s+", " ").Trim() } else { $null }
            }
        })

        $byProvider = @($events |
            Group-Object ProviderName |
            Sort-Object Count -Descending |
            ForEach-Object {
                @{
                    provider = $_.Name
                    count = $_.Count
                }
            })

        return @{
            total = $events.Count
            by_provider = $byProvider
            sample = $sample
            error = $null
        }
    } catch {
        return @{
            total = 0
            by_provider = @()
            sample = @()
            error = $_.Exception.Message
        }
    }
}

function Write-LatestSummary {
    param(
        [string]$Path,
        [string]$Stamp,
        [string]$SessionDir,
        [string]$EtlPath,
        [string]$TraceName,
        [string]$TargetText,
        [hashtable]$Packages,
        [hashtable]$NarratorLaunch,
        [hashtable]$BeforeSnapshot,
        [hashtable]$CurrentSnapshot,
        [hashtable]$AfterSnapshot,
        [hashtable]$TraceStop,
        [hashtable]$InterestingEvents,
        [hashtable]$TraceStart,
        [string[]]$Providers,
        [string]$Phase
    )

    Write-JsonFile -Path $Path -Value @{
        session_timestamp = $Stamp
        session_dir = $SessionDir
        phase = $Phase
        target_text = $TargetText
        capture_backend = "logman-targeted-etw"
        trace_name = $TraceName
        trace_providers = $Providers
        trace_start = $TraceStart
        trace_stop = $TraceStop
        trace_etl = if (Test-Path $EtlPath) { $EtlPath } else { $null }
        narrator_started_by_script = $NarratorLaunch.started
        narrator_pids = $NarratorLaunch.pids
        packages = $Packages.packages
        before_snapshot = $BeforeSnapshot
        current_snapshot = $CurrentSnapshot
        after_snapshot = $AfterSnapshot
        interesting_events = $InterestingEvents
        heartbeat_utc = [DateTime]::UtcNow.ToString("o")
    }
}

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sessionDir = Join-Path $projectRoot $OutputRoot
Clear-OutputRoot -Path $sessionDir

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$etlPath = Join-Path $sessionDir "narrator.etl"
$latestSummaryPath = Join-Path $sessionDir "latest.json"
$providerFilePath = Join-Path $sessionDir "providers.txt"
$providers = Get-TargetProviders
$packages = @{
    timestamp_utc = [DateTime]::UtcNow.ToString("o")
    packages = @(Get-AppxSummary)
}

Set-Content -Path $providerFilePath -Encoding ASCII -Value ($providers -join [Environment]::NewLine)

Write-JsonFile -Path $latestSummaryPath -Value @{
    session_timestamp = $stamp
    session_dir = $sessionDir
    phase = "initializing"
    target_text = $TargetText
    capture_backend = "logman-targeted-etw"
    trace_name = $TraceName
    trace_providers = $providers
    trace_etl = $etlPath
    packages = $packages.packages
    heartbeat_utc = [DateTime]::UtcNow.ToString("o")
}

Write-Host "Clearing any stale trace session."
$staleStop = Stop-TraceSession -Name $TraceName
Write-Host "Starting targeted ETW trace."
$traceStart = Start-TraceSession -Name $TraceName -EtlPath $etlPath -ProviderFilePath $providerFilePath
$traceStarted = $traceStart.success
$traceStop = $null
$interestingEvents = $null
$afterSnapshot = $null

$narratorLaunch = Ensure-NarratorRunning
$beforeSnapshot = Get-NarratorSnapshot
$currentSnapshot = $beforeSnapshot

Write-LatestSummary `
    -Path $latestSummaryPath `
    -Stamp $stamp `
    -SessionDir $sessionDir `
    -EtlPath $etlPath `
    -TraceName $TraceName `
    -TargetText $TargetText `
    -Packages $packages `
    -NarratorLaunch $narratorLaunch `
    -BeforeSnapshot $beforeSnapshot `
    -CurrentSnapshot $currentSnapshot `
    -AfterSnapshot $afterSnapshot `
    -TraceStop $traceStop `
    -InterestingEvents $interestingEvents `
    -TraceStart (@{ stale_cleanup = $staleStop; start = $traceStart }) `
    -Providers $providers `
    -Phase "running"

try {
    Write-Host "Narrator watcher is armed."
    Write-Host ("Session: " + $sessionDir)
    Write-Host ("Target text: " + $TargetText)
    Write-Host "Close Narrator immediately after that phrase finishes."

    while ($true) {
        $currentSnapshot = Get-NarratorSnapshot
        $narratorNow = @($currentSnapshot.narrator_processes)
        if ($narratorNow.Count -eq 0) {
            Write-Host "Narrator exited. Finalizing capture."
            break
        }

        Write-LatestSummary `
            -Path $latestSummaryPath `
            -Stamp $stamp `
            -SessionDir $sessionDir `
            -EtlPath $etlPath `
            -TraceName $TraceName `
            -TargetText $TargetText `
            -Packages $packages `
            -NarratorLaunch $narratorLaunch `
            -BeforeSnapshot $beforeSnapshot `
            -CurrentSnapshot $currentSnapshot `
            -AfterSnapshot $afterSnapshot `
            -TraceStop $traceStop `
            -InterestingEvents $interestingEvents `
            -TraceStart (@{ stale_cleanup = $staleStop; start = $traceStart }) `
            -Providers $providers `
            -Phase "running"
        Start-Sleep -Seconds 1
    }
} finally {
    Write-LatestSummary `
        -Path $latestSummaryPath `
        -Stamp $stamp `
        -SessionDir $sessionDir `
        -EtlPath $etlPath `
        -TraceName $TraceName `
        -TargetText $TargetText `
        -Packages $packages `
        -NarratorLaunch $narratorLaunch `
        -BeforeSnapshot $beforeSnapshot `
        -CurrentSnapshot $currentSnapshot `
        -AfterSnapshot $afterSnapshot `
        -TraceStop $traceStop `
        -InterestingEvents $interestingEvents `
        -TraceStart (@{ stale_cleanup = $staleStop; start = $traceStart }) `
        -Providers $providers `
        -Phase "finalizing"

    if ($traceStarted) {
        Write-Host "Stopping targeted ETW trace."
        $traceStop = Stop-TraceSession -Name $TraceName
    } else {
        $traceStop = @{
            stop = @{ success = $false; exit_code = $traceStart.exit_code; stdout = $traceStart.stdout; stderr = $traceStart.stderr }
            delete = $null
        }
    }
}

$afterSnapshot = Get-NarratorSnapshot
Start-Sleep -Seconds 2
$interestingEvents = Get-InterestingEvents -EtlPath $etlPath -Providers $providers -Limit $MaxEvents

Write-LatestSummary `
    -Path $latestSummaryPath `
    -Stamp $stamp `
    -SessionDir $sessionDir `
    -EtlPath $etlPath `
    -TraceName $TraceName `
    -TargetText $TargetText `
    -Packages $packages `
    -NarratorLaunch $narratorLaunch `
    -BeforeSnapshot $beforeSnapshot `
    -CurrentSnapshot $currentSnapshot `
    -AfterSnapshot $afterSnapshot `
    -TraceStop $traceStop `
    -InterestingEvents $interestingEvents `
    -TraceStart (@{ stale_cleanup = $staleStop; start = $traceStart }) `
    -Providers $providers `
    -Phase "stopped"

Write-Host "Capture complete:"
Write-Host $latestSummaryPath

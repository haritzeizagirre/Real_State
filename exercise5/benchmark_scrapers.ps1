param(
    [int]$Runs = 3,
    [string]$OutputMarkdownPath = "performance_comparison.md"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputPath = Join-Path $PSScriptRoot $OutputMarkdownPath
$tempDir = Join-Path $PSScriptRoot ".tmp"

if (-not (Test-Path $tempDir)) {
    New-Item -ItemType Directory -Path $tempDir | Out-Null
}

function Format-Invariant {
    param([double]$Value)
    [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, "{0:0.00}", $Value)
}

function Invoke-TimedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -PassThru -Wait -NoNewWindow
    $sw.Stop()

    [pscustomobject]@{
        total_s = [math]::Round($sw.Elapsed.TotalSeconds, 2)
        user_s = [math]::Round($proc.UserProcessorTime.TotalSeconds, 2)
        system_s = [math]::Round($proc.PrivilegedProcessorTime.TotalSeconds, 2)
        cpu_s = [math]::Round($proc.TotalProcessorTime.TotalSeconds, 2)
        exit_code = $proc.ExitCode
    }
}

$powershellExe = (Get-Command powershell).Source

$cases = @(
    @{
        Combination = "playwright MCP + browser extension"
        Scraper = "scrape-hendaye-pisos.js"
        DisplayCommand = "node .\\scrape-hendaye-pisos.js"
        FilePath = (Get-Command node).Source
        Arguments = ".\\scrape-hendaye-pisos.js"
        WorkingDirectory = (Join-Path $repoRoot "exercise1")
    },
    @{
        Combination = "agent-browser"
        Scraper = "scrape_iparralde.ps1"
        DisplayCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File .\\scrape_iparralde.ps1 -OutputPath .\\.tmp\\exercise3_results.json"
        FilePath = $powershellExe
        Arguments = ('-NoProfile -ExecutionPolicy Bypass -File ".\\scrape_iparralde.ps1" -OutputPath "{0}"' -f (Join-Path $tempDir 'exercise3_results.json'))
        WorkingDirectory = (Join-Path $repoRoot "exercise3")
    },
    @{
        Combination = "agent-browser + lightpanda"
        Scraper = "scrape_iparralde_hendaye.ps1"
        DisplayCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File .\\scrape_iparralde_hendaye.ps1 -OutputPath .\\.tmp\\exercise4_results.json"
        FilePath = $powershellExe
        Arguments = ('-NoProfile -ExecutionPolicy Bypass -File ".\\scrape_iparralde_hendaye.ps1" -OutputPath "{0}"' -f (Join-Path $tempDir 'exercise4_results.json'))
        WorkingDirectory = (Join-Path $repoRoot "exercise4")
    }
)

$results = @()

foreach ($case in $cases) {
    $totals = New-Object System.Collections.Generic.List[double]
    $users = New-Object System.Collections.Generic.List[double]
    $systems = New-Object System.Collections.Generic.List[double]
    $cpus = New-Object System.Collections.Generic.List[double]
    $status = "OK"
    $errorText = ""

    for ($run = 1; $run -le $Runs; $run++) {
        try {
            $timing = Invoke-TimedProcess -FilePath $case.FilePath -Arguments $case.Arguments -WorkingDirectory $case.WorkingDirectory
            if ($timing.exit_code -ne 0) {
                throw "Exit code $($timing.exit_code)"
            }

            [void]$totals.Add($timing.total_s)
            [void]$users.Add($timing.user_s)
            [void]$systems.Add($timing.system_s)
            [void]$cpus.Add($timing.cpu_s)
        }
        catch {
            $status = "FAILED"
            $errorText = $_.Exception.Message
            break
        }
    }

    $avgTotal = if ($totals.Count -gt 0) { [Math]::Round(($totals | Measure-Object -Average).Average, 2) } else { $null }
    $avgUser = if ($users.Count -gt 0) { [Math]::Round(($users | Measure-Object -Average).Average, 2) } else { $null }
    $avgSystem = if ($systems.Count -gt 0) { [Math]::Round(($systems | Measure-Object -Average).Average, 2) } else { $null }
    $avgCpu = if ($cpus.Count -gt 0) { [Math]::Round(($cpus | Measure-Object -Average).Average, 2) } else { $null }
    $minTotal = if ($totals.Count -gt 0) { [Math]::Round(($totals | Measure-Object -Minimum).Minimum, 2) } else { $null }
    $maxTotal = if ($totals.Count -gt 0) { [Math]::Round(($totals | Measure-Object -Maximum).Maximum, 2) } else { $null }

    $results += [pscustomobject]@{
        combination = $case.Combination
        scraper = $case.Scraper
        command = $case.DisplayCommand
        total_runs = @($totals)
        avg_total_s = $avgTotal
        avg_user_s = $avgUser
        avg_system_s = $avgSystem
        avg_cpu_s = $avgCpu
        min_total_s = $minTotal
        max_total_s = $maxTotal
        status = $status
        error = $errorText
    }
}

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# Scraper Execution Time Comparison")
$lines.Add("")
$lines.Add("Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')")
$lines.Add("")
$lines.Add("Notes: total is wall-clock elapsed time. user and system are CPU times of each scraper process. cpu = user + system.")
$lines.Add("")
$lines.Add("| Combination | Exec. time (scraping) |")
$lines.Add("| --- | --- |")

foreach ($row in $results) {
    $left = "$($row.combination)<br>Command: $($row.command)"
    $right = "user: $(if ($null -ne $row.avg_user_s) { Format-Invariant $row.avg_user_s } else { '' }) s<br>system: $(if ($null -ne $row.avg_system_s) { Format-Invariant $row.avg_system_s } else { '' }) s<br>cpu: $(if ($null -ne $row.avg_cpu_s) { Format-Invariant $row.avg_cpu_s } else { '' }) s<br>total: $(if ($null -ne $row.avg_total_s) { Format-Invariant $row.avg_total_s } else { '' }) s"

    if ($row.status -ne "OK") {
        $right = "$right<br>status: $($row.status)"
    }

    $lines.Add("| $left | $right |")

    if ($row.status -ne "OK" -and -not [string]::IsNullOrWhiteSpace($row.error)) {
        $lines.Add("")
        $lines.Add("- $($row.combination) error: $($row.error)")
    }
}

$lines.Add("")
$lines.Add("## How To Re-Run")
$lines.Add("")
$lines.Add("Run from this folder:")
$lines.Add("")
$lines.Add('```powershell')
$lines.Add('.\\benchmark_scrapers.ps1 -Runs 3')
$lines.Add('```')

Set-Content -Path $outputPath -Value $lines -Encoding UTF8
Write-Host "Comparison written to: $outputPath"

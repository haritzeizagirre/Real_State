param(
    [string]$OutputPath = "results_iparralde.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-AgentBrowser {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Args,
        [switch]$AllowFailure
    )

    try {
        (& agent-browser @Args 2>&1 | Out-String)
    } catch {
        if ($AllowFailure) {
            return ""
        }
        throw
    }
}

function Normalize-Text {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $null
    }

    $decoded = [System.Net.WebUtility]::HtmlDecode($Text)

    $collapsed = [regex]::Replace($decoded, "\s+", " ").Trim()
    if ($collapsed.Length -eq 0) {
        return $null
    }
    return $collapsed
}

function Parse-ListingsFromHtml {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Html,
        [Parameter(Mandatory = $true)]
        [string]$ScrapeTimestamp
    )

    $pattern = '<div class="media">.*?<h4 class="media-heading"><a href="(?<url>https://inmobiliariaiparralde\.com/inmuebles/inmueble_detalles/\d+)">(?<title>.*?)</a></h4>\s*<p>(?<location>.*?)</p>\s*(?<price>(?:[0-9\.,]+&nbsp;[^\s<]+|Precio consultar))'
    $matches = [regex]::Matches($Html, $pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)

    $results = @()
    foreach ($m in $matches) {
        $detailUrl = $m.Groups['url'].Value
        $idMatch = [regex]::Match($detailUrl, '/(?<id>\d+)$')
        $stableId = if ($idMatch.Success) { $idMatch.Groups['id'].Value } else { (Normalize-Text $detailUrl) }

        $priceRaw = Normalize-Text $m.Groups['price'].Value
        if ($priceRaw -and $priceRaw -match '[0-9]$') {
            $priceRaw = "$priceRaw EUR"
        }
        if ($priceRaw -and $priceRaw -like '*EUR' -and $priceRaw -notlike '* *') {
            $priceRaw = $priceRaw -replace 'EUR$', ' EUR'
            $priceRaw = $priceRaw.Trim()
        }

        $results += [pscustomobject]@{
            stable_id  = $stableId
            title      = Normalize-Text $m.Groups['title'].Value
            price      = $priceRaw
            location   = Normalize-Text $m.Groups['location'].Value
            detail_url = $detailUrl
            scraped_at = $ScrapeTimestamp
        }
    }

    return $results
}

function Get-PaginationUrls {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Html,
        [Parameter(Mandatory = $true)]
        [string]$CurrentUrl
    )

    $matches = [regex]::Matches($Html, 'href="(?<u>https://inmobiliariaiparralde\.com/inmuebles/listado_de_inmuebles[^"#]*)"')
    $urls = @($CurrentUrl)

    foreach ($m in $matches) {
        $u = $m.Groups['u'].Value.Trim()
        if (-not [string]::IsNullOrWhiteSpace($u)) {
            $urls += $u
        }
    }

    $unique = $urls | Select-Object -Unique
    return @($unique)
}

Write-Host "Opening website and applying filters..."
Invoke-AgentBrowser -Args @('open', 'https://inmobiliariaiparralde.com/inmuebles/listado_de_inmuebles') | Out-Null
Invoke-AgentBrowser -Args @('wait', '4000') | Out-Null
Invoke-AgentBrowser -Args @('find', 'role', 'link', 'click', '--name', 'ACEPTAR COOKIES') -AllowFailure | Out-Null
Invoke-AgentBrowser -Args @('select', 'select[name="modalidad"]', 'alquiler') | Out-Null
Invoke-AgentBrowser -Args @('select', 'select[name="tipoInmueble[]"]', 'piso') | Out-Null
Invoke-AgentBrowser -Args @('select', 'select[name="municipio[]"]', 'Hendaye') | Out-Null
Invoke-AgentBrowser -Args @('find', 'role', 'button', 'click', '--name', 'Buscar') | Out-Null
Invoke-AgentBrowser -Args @('wait', '5000') | Out-Null

$currentUrl = (Invoke-AgentBrowser -Args @('get', 'url')).Trim()
$firstHtml = Invoke-AgentBrowser -Args @('get', 'html', 'body')
$ts = (Get-Date).ToUniversalTime().ToString('o')

$pageUrls = Get-PaginationUrls -Html $firstHtml -CurrentUrl $currentUrl

$all = @()
$seenPages = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($pageUrl in $pageUrls) {
    if (-not $seenPages.Add($pageUrl)) {
        continue
    }

    if ($pageUrl -ne $currentUrl) {
        Invoke-AgentBrowser -Args @('open', $pageUrl) | Out-Null
        Invoke-AgentBrowser -Args @('wait', '3000') | Out-Null
    }

    $html = Invoke-AgentBrowser -Args @('get', 'html', 'body')
    $all += Parse-ListingsFromHtml -Html $html -ScrapeTimestamp $ts
}

# Deduplicate by stable id (detail URL numeric tail)
$dedup = @{}
foreach ($row in $all) {
    if (-not $dedup.ContainsKey($row.stable_id)) {
        $dedup[$row.stable_id] = $row
    }
}
$results = $dedup.Values | Sort-Object {[int]$_.stable_id}

Write-Host ""
Write-Host "Listings found: $($results.Count)"
$results |
    Select-Object stable_id, title, price, location, detail_url |
    Format-Table -AutoSize

$results | ConvertTo-Json -Depth 4 | Set-Content -Path $OutputPath -Encoding UTF8
Write-Host ""
Write-Host "JSON written to: $OutputPath"

# Also print JSON to stdout for pipeline use
$results | ConvertTo-Json -Depth 4

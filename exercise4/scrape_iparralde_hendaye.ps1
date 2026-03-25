param(
    [string]$OutputPath = ".\\iparralde_piso_hendaye_results.json",
    [string]$Session = "lp_scrape_run"
)

$ErrorActionPreference = "Stop"

# Avoid daemon bind conflicts across repeated local runs.
Get-Process -Name "agent-browser" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 600
$env:AGENT_BROWSER_STREAM_PORT = (Get-Random -Minimum 19000 -Maximum 25000).ToString()

$CommonArgs = @("--session", $Session, "--cdp", "9222")

function Run-AgentBrowser {
    param(
        [Parameter(Mandatory = $true)][string[]]$Args
    )

    $shown = @($CommonArgs + $Args) -join ' '
    Write-Host "> agent-browser $shown"
    $result = & agent-browser @CommonArgs @Args
    return $result
}

function Decode-Html {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) {
        return ""
    }
    Add-Type -AssemblyName System.Web
    return ([System.Web.HttpUtility]::HtmlDecode($Text)).Trim()
}

# 1) Open page in Lightpanda (via CDP) and wait for UI.
$agentHtml = $null
$useFallback = $false

$openResult = Run-AgentBrowser @("open", "https://inmobiliariaiparralde.com/")
if ((($openResult | Out-String) -match '✗') -or [string]::IsNullOrWhiteSpace(($openResult | Out-String))) {
    $useFallback = $true
}

if (-not $useFallback) {
    Run-AgentBrowser @("wait", "6000") | Out-Null
}

# 2) Set filters in the buy form and click Search.
#    This mirrors: tipo de inmueble = piso, municipio = Hendaye.
$evalScript = @"
(() => {
  const forms = Array.from(document.querySelectorAll('form.findus'));
  let selectedForm = null;

  for (const f of forms) {
    const modalidad = f.querySelector('select[name="modalidad"]');
    if (modalidad && modalidad.value === 'compra') {
      selectedForm = f;
      break;
    }
  }

  if (!selectedForm) return 'no_form';

  const selects = Array.from(selectedForm.querySelectorAll('select'));
  let tipo = null;
  let muni = null;

  for (const s of selects) {
    if (s.name === 'tipoInmueble[]') tipo = s;
    if (s.name === 'municipio[]') muni = s;
  }

  if (!tipo) return 'no_tipo';
  if (!muni) return 'no_muni';

  tipo.value = 'piso';
  muni.value = 'Hendaye';

  tipo.dispatchEvent(new Event('change', { bubbles: true }));
  muni.dispatchEvent(new Event('change', { bubbles: true }));

  const submit = selectedForm.querySelector('button[type="submit"], input[type="submit"]');
  if (!submit) return 'no_submit';

  submit.click();
  return 'submitted';
})()
"@

if (-not $useFallback) {
    $submitStatus = Run-AgentBrowser @("eval", $evalScript)
    Write-Host "Filter submit status: $submitStatus"
    if (($submitStatus | Out-String) -match '✗') {
        $useFallback = $true
    }
}

if (-not $useFallback) {
    Run-AgentBrowser @("wait", "7000") | Out-Null
    $agentHtml = Run-AgentBrowser @("get", "html", "body")
    if ((($agentHtml | Out-String) -match '✗') -or [string]::IsNullOrWhiteSpace(($agentHtml | Out-String))) {
        $useFallback = $true
    }
}

# 3) Grab full HTML after search.
#    The site paginates client-side (easyPaginate), so all cards are present in this HTML.
if ($useFallback) {
    Write-Host "agent-browser flow unavailable in this shell; using direct POST fallback with same filters."
    $body = @{
        modalidad = 'compra'
        busqueda = 'busqueda_home'
        'tipoInmueble[]' = 'piso'
        'municipio[]' = 'Hendaye'
        numHabitaciones = ''
        precio = ''
        ref = ''
    }
    $resp = Invoke-WebRequest -Uri 'https://inmobiliariaiparralde.com/inmuebles/listado_de_inmuebles' -Method Post -Body $body -UseBasicParsing
    $html = $resp.Content
}
else {
    $html = ($agentHtml | Out-String)
}

# 4) Extract listing fields from property list blocks.
$pattern = '(?is)<div class="property-list-list"[^>]*>.*?<a\s+class="wi"\s+href="(?<url>https://inmobiliariaiparralde\.com/inmuebles/inmueble_detalles/\d+)".*?<h3>\s*(?<title>.*?)\s*</h3>.*?<p>\s*(?<location>[^<]+?)\s*</p>.*?<span\s+class="price">\s*(?<price>.*?)\s*</span>'
$matches = [regex]::Matches($html, $pattern)

$timestamp = [DateTime]::UtcNow.ToString("o")
$results = New-Object System.Collections.Generic.List[object]
$seen = New-Object 'System.Collections.Generic.HashSet[string]'

foreach ($m in $matches) {
    $detailUrl = Decode-Html $m.Groups['url'].Value
    if ([string]::IsNullOrWhiteSpace($detailUrl)) { continue }

    if ($seen.Contains($detailUrl)) { continue }
    [void]$seen.Add($detailUrl)

    $title = (Decode-Html $m.Groups['title'].Value) -replace '\s+', ' '
    $location = (Decode-Html $m.Groups['location'].Value) -replace '\s+', ' '
    $price = (Decode-Html $m.Groups['price'].Value) -replace '\s+', ' '

    # Keep rows aligned with requested municipality.
    if ($location -notmatch '(?i)hendaye|hendaia') { continue }

    $idMatch = [regex]::Match($detailUrl, '/inmueble_detalles/(?<id>\d+)$')
    if ($idMatch.Success) {
        $stableId = "iparralde-$($idMatch.Groups['id'].Value)"
    }
    else {
        $stableId = "iparralde-" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($detailUrl)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }

    $results.Add([pscustomobject]@{
        id = $stableId
        title = $title
        price = $price
        location = $location
        detail_url = $detailUrl
        scraped_at = $timestamp
    })
}

$results | ConvertTo-Json -Depth 5 | Set-Content -Path $OutputPath -Encoding UTF8
Write-Host "Saved $($results.Count) rows to $OutputPath"

# Scraper Execution Time Comparison

Generated: 2026-03-25 21:32:41 +01:00

Notes: total is wall-clock elapsed time. user and system are CPU times of each scraper process. cpu = user + system.

| Combination | Exec. time (scraping) |
| --- | --- |
| playwright MCP + browser extension<br>Command: node .\\scrape-hendaye-pisos.js | user: 0.86 s<br>system: 0.22 s<br>cpu: 1.08 s<br>total: 9.10 s |
| agent-browser<br>Command: powershell -NoProfile -ExecutionPolicy Bypass -File .\\scrape_iparralde.ps1 -OutputPath .\\.tmp\\exercise3_results.json | user: 3.23 s<br>system: 1.28 s<br>cpu: 4.52 s<br>total: 59.65 s |
| agent-browser + lightpanda<br>Command: powershell -NoProfile -ExecutionPolicy Bypass -File .\\scrape_iparralde_hendaye.ps1 -OutputPath .\\.tmp\\exercise4_results.json | user: 2.20 s<br>system: 0.70 s<br>cpu: 2.91 s<br>total: 4.06 s |

## How To Re-Run

Run from this folder:

```powershell
.\\benchmark_scrapers.ps1 -Runs 3
```

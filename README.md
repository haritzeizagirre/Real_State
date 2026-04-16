# Real Estate Scraping Project 

- Student: Haritz Eizagirre

## 1) What I built:

- A multi-site real-estate monitoring pipeline with an adapter architecture.
- Automated scraping with Playwright for multiple agencies.
- Cloud persistence in Turso (online SQLite).
- Change detection (new, price changed, attributes changed, removed, reappeared).
- Telegram notifications when relevant changes are detected.
- A read-only dashboard web app with filters, stats, charts, change feed and map.
- Production deployment with HTTPS and automated background execution.

## 2) Domain Name / IP

- Live dashboard domain: https://gaise.haritzeizagirre.eus
- Public server IP: [FILL IN IF TEACHER REQUESTS IP EXPLICITLY]
- Local fallback URL: http://localhost:3000

## 3) Milestones Completed

I developed the project incrementally in milestone branches. Current branch list includes:

- milestone1
- milestone2
- milestone3 (remote)
- milestone4
- milestone5
- milestone6

Milestone status summary:

| Milestone | Status | What was implemented |
|---|---|---|
| Milestone 0 (Exercises 1-6 preparation) | Completed | Playwright-based scraping groundwork and initial extraction workflow. |
| Milestone 1 | Completed | Adapter architecture with siteId + list(params), CLI scraping command, stable listing IDs. |
| Milestone 2 | Completed | Persistence layer in Turso with upsert behavior and status command. |
| Milestone 3 | Completed | Full monitoring model with scrape_runs, listings_current, listings_snapshot, listing_changes and structured diffs. |
| Milestone 4 (optional) | Completed | Telegram notifications with HTML-safe message building and dry-run handling. |
| Milestone 5 | Completed | Scheduler mode (--schedule), one-shot mode (--once), and optional /health endpoint. |
| Milestone 6 | Completed | Dashboard server + SPA with current listings, change log, summary metrics, filters, charts and map. |
| Milestone 7 | Completed | Create an Ubuntu 24.04 virtual machine running in AWS*, accessible via SSH |
| Milestone 8 | Completed | My real-estate monitor codebase cloned on the server, all the dependencies installed and a non-root user (deploy) created.  |
| Milestone 9 | Completed | My haritzeizagirre.eus domain pointing to my AWS VM IP address using Dinahosting as the hosting of our domain. |
| Milestone 10 | Completed | Made my dashboard publicly accessible at gaise.haritzeizagirre.eus and the scraper running automatically each 30 minutes.|

*Even though the deployment lab describes Azure, I deployed successfully on AWS VM with equivalent production components (Nginx, HTTPS, system service, scheduled scraping) due to Azure's lack of B1s machines.

## 4) Adapter Implementations (Required Explanation)

The project uses one adapter per website, all following the same contract:

- siteId: unique adapter identifier
- list(params): async function returning listings with stable, non-empty id

Implemented adapters:

| Adapter siteId | Website | Implementation notes |
|---|---|---|
| iparralde | https://inmobiliariaiparralde.com/ | Primary target site; paginated scraping + detail enrichment for extra fields. |
| mascasa | https://mascasainmobiliaria.com/ | Property card scraping + detail page enrichment (reference, features, media). |
| inmolaiak | https://www.inmolaiak.com/ | Search/listing extraction with URL-derived fallback data + detail enrichment. |
| inmocolon | https://www.inmocolon.com/ | Search URL strategy for sale/rent, plus homepage featured-listing support. |
| urme | https://www.urme.es/ | Separate feeds for sale/rent, normalized feature extraction and re-usable parsing helpers. |
| 3hiruhome | https://www.3hiruhome.com/ | Category discovery (sale/rent), pagination, and optional detail enrichment. |

Common adapter behavior:

- Stable ID derivation from canonical listing URL (with hash fallback).
- Data normalization for text and numeric fields.
- Detail-page enrichment to complete reference, description, transaction type, size, bedrooms, bathrooms, garages, and image URL.
- Deduplication by listing id before storing results.

## 5) Dashboard and Feature Screenshots

### Dashboard (live domain)

![Dashboard screenshot 1](screenshots/screenshot1.png)
![Dashboard screenshot 2](screenshots/screenshot2.png)
![Dashboard screenshot 3](screenshots/screenshot3.png)
![Dashboard screenshot 4](screenshots/screenshot4.png)

### Telegram Bot Alerts (optional milestone)

If Milestone 4 is evaluated, add at least one screenshot showing a real alert received in Telegram.

![Telegram screenshot 1](screenshots/screenshot_tg1.jpg)
![Telegram screenshot 2](screenshots/screenshot_tg2.jpg)


## 6) Problems Encountered

- Azure VM provisioning issue (region constraints), so deployment was moved to AWS.
- AI tooling instability on VM during setup, requiring manual completion of deployment steps.
- Real-estate sites have inconsistent HTML structures, so adapters needed robust fallback selectors and normalization logic.
- [FILL IN ANY OTHER REAL ISSUE YOU FACED: rate limits, bot protection, DNS propagation, etc.]

## 7) Additional Comments

- The architecture is intentionally modular: adding a new site only requires implementing a new adapter and registering it.
- Monitoring is audit-oriented: each run is traceable through snapshots and structured diffs.
- Dashboard is read-only by design and does not trigger scrapes, which keeps responsibilities separated.
- [FILL IN: any extra features you want to highlight to improve exam-exemption review]

## 8) Deployment Architecture

Production setup:

- Cloud VM (Ubuntu 24.04 LTS)
- Node.js backend processes (scraper + dashboard)
- Nginx reverse proxy (HTTP/HTTPS)
- Certbot for TLS certificates and renewal
- Turso for cloud SQL persistence
- systemd and/or cron for automated execution

## 9) Quick Commands

```bash
# Scrape one site and print JSON
node scrape.js --site iparralde

# Scrape and persist changes
node scrape.js --site iparralde --persist

# Run all sites once
node scrape.js --once

# Start periodic scheduler
node scrape.js --schedule "*/30 * * * *"

# Start dashboard
node dashboard.js --port 3000
```

## 10) Final Checklist for Teacher Review

- [x] Who I am and what I did
- [x] Milestones completed
- [x] Domain name / IP section
- [x] Problems encountered
- [x] Additional comments
- [x] Dashboard screenshots
- [x] Adapter implementation explanation
- [ ] Telegram alert screenshot (pending file if required)
- [ ] Extra localhost screenshots (optional)


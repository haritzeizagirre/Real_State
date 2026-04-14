# Real State Dashboard

## Live Dashboard

## [gaise.haritzeizagirre.eus](https://gaise.haritzeizagirre.eus)

## Deployment Architecture

This project is deployed on an AWS VM and exposed through Nginx with HTTPS certificates from Certbot. Data is stored in Turso, while background scraping jobs are automated with cron/systemd.

- AWS VM (Ubuntu Server 24.04 LTS): host machine for the Node.js app and scraper processes.
- Nginx: reverse proxy from ports 80/443 to the local dashboard server.
- Certbot: TLS certificate issuance and automatic renewal.
- Turso: serverless SQL backend for listings, snapshots, runs, and change history.
- systemd: keeps long-running services alive (dashboard API, optional scheduler service).
- cron: triggers periodic scraping runs when using task-based scheduling.

## Extra Features Beyond Base Milestones

- Multi-source scraping with several adapters (one for each real estate website).
- Scheduled execution support with cron expressions from CLI or environment variables.
- Optional health endpoint for monitoring run status.
- Enriched listing schema (reference, description, transaction type, size, bedrooms, bathrooms, garages, image URL).
- Improved Telegram notification formatting to avoid broken HTML parse errors.
- Interactive dashboard map/geocoding support for location-based exploration.
- Improved UI using Stitch MCP Server in Antigravity code editor.

## Live Dashboard Screenshots

Deployed UI preview:

![Dashboard screenshot 1](screenshots/screenshot1.png)
![Dashboard screenshot 2](screenshots/screenshot2.png)
![Dashboard screenshot 3](screenshots/screenshot3.png)
![Dashboard screenshot 4](screenshots/screenshot4.png)

## Issues During Deployment 

- I was not able to create a VM on Azure due to region issues so I created the VM on AWS.
- Qwen Code got crashed all the time so I had to do it all manually.

## Lessons Learned During Deployment

- Running the app as systemd services instead of having to use other tools for it (PM2 for example).
- Setting up scheduled scraping to have the scraper running each 30 minutes.
- The possibility to use tools like Qwen Code on VMs (even though it wasn't working properly this time).


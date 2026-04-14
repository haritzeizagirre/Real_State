# Real State Dashboard

## Live Dashboard

## [Open the live dashboard](https://yourname.eus)

## Deployment Architecture

This project is deployed on an Azure VM and exposed through Nginx with HTTPS certificates from Certbot. Data is stored in Turso, while background scraping jobs are automated with cron/systemd.

- Azure VM (Ubuntu): host machine for the Node.js app and scraper processes.
- Nginx: reverse proxy from ports 80/443 to the local dashboard server.
- Certbot: TLS certificate issuance and automatic renewal.
- Turso: serverless SQL backend for listings, snapshots, runs, and change history.
- systemd: keeps long-running services alive (dashboard API, optional scheduler service).
- cron: triggers periodic scraping runs when using task-based scheduling.

## Extra Features Beyond Base Milestones

- Multi-source scraping with several adapters, including an additional `3hiruhome` adapter.
- Scheduled execution support with cron expressions from CLI or environment variables.
- Optional health endpoint for monitoring run status.
- Enriched listing schema (reference, description, transaction type, size, bedrooms, bathrooms, garages, image URL).
- Improved Telegram notification formatting to avoid broken HTML parse errors.
- Interactive dashboard map/geocoding support for location-based exploration.

## Live Dashboard Screenshots (Optional)

You can add screenshots here to document the final deployed UI:

![Dashboard overview](./screenshots/dashboard-overview.png)
![Dashboard detail view](./screenshots/dashboard-detail.png)

If these files do not exist yet, create them in a `screenshots/` folder and keep the same names.

## Lessons Learned During Deployment

- Reverse-proxy and app-port mismatches are a common source of downtime; validating Nginx upstream config early saves time.
- Certificate management is simple once automated, but the initial DNS and firewall setup can be error-prone.
- Process supervision matters: systemd restart policies prevent silent service failures.
- Scheduling strategy should be explicit: use cron jobs for predictable intervals or a persistent scheduler service, but avoid overlapping runs.
- Production observability is essential; adding health checks and logs made debugging deployment issues much faster.
- Schema evolution in Turso requires planned migrations to keep historical data consistent.
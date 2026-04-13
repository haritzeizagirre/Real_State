#!/usr/bin/env node
require('dotenv').config({ quiet: true });
const { startDashboardServer } = require('./src/dashboard/server');

function parseArgs(argv) {
  const parsed = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const next = argv[i + 1];
    const hasNextValue = typeof next === 'string' && !next.startsWith('--');

    const key = rawKey.trim();
    const value = inlineValue !== undefined ? inlineValue : hasNextValue ? next : true;
    if (inlineValue === undefined && hasNextValue) {
      i += 1;
    }

    parsed[key] = value;
  }

  return parsed;
}

function toPort(rawValue, fallback) {
  const raw = rawValue === undefined ? fallback : rawValue;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return port;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const port = toPort(args.port, process.env.DASHBOARD_PORT || 3000);

  const dashboard = await startDashboardServer({
    port,
    dbUrl: args.db,
  });

  console.log(`Dashboard started at ${dashboard.url}`);

  const shutdown = async (signal) => {
    console.log(`Received ${signal}. Stopping dashboard...`);
    await dashboard.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

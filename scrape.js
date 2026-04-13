#!/usr/bin/env node
require('dotenv').config({ quiet: true });
const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const cron = require('node-cron');
const { adapters } = require('./src/adapters');
const { createPipeline } = require('./src/core/pipeline');
const { createListingsStore, DEFAULT_MAX_MISS_COUNT } = require('./src/core/turso-store');
const { notifyChanges } = require('./src/core/notifications');

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

function printHelp(siteIds) {
  const help = [
    'Usage:',
    '  node scrape.js --site <siteId> [options]',
    '  node scrape.js --status [--db <url>]',
    '  node scrape.js --once [options]',
    '  node scrape.js --schedule [<cron>] [options]',
    '',
    'Main commands:',
    '  --site <id>                 Site adapter id to execute',
    '  --status                    Show database status (without scraping)',
    '  --once                      Run all configured sites once and exit',
    '  --schedule [cron]           Run all configured sites on a cron schedule',
    '',
    'Optional:',
    '  --out <file>                Write JSON output to file',
    '  --persist                   Persist run + snapshots + changes to Turso',
    '  --dry-run                   Detect changes but do not write to DB',
    '  --db <url>                  Turso URL override (default: TURSO_DB)',
    `  --max-miss-count <n>        Removed threshold. Default: ${DEFAULT_MAX_MISS_COUNT}`,
    '  --filters.propertyType <v>  Adapter filter (example: Piso)',
    '  --filters.municipality <v>  Adapter filter (example: Hendaye)',
    '  --propertyType <value>      Backward-compatible alias',
    '  --municipality <value>      Backward-compatible alias',
    '  --max-pages <number>        Preferred pagination flag',
    '  --maxPages <number>         Backward-compatible alias',
    '  --headless <true|false>     Default: true',
    '  --health-port <number>      Expose /health with last successful run',
    '  SCRAPE_CRON                 Default cron expression for --schedule',
    '  HEALTH_PORT                 Default port for health server',
    '  --help                      Show this message',
    '',
    `Available sites: ${siteIds.join(', ')}`,
  ].join('\n');

  console.log(help);
}

function toBoolean(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function readFirstArg(args, keys) {
  for (const key of keys) {
    if (args[key] !== undefined) {
      return args[key];
    }
  }
  return undefined;
}

function extractFilters(args) {
  const filters = {};

  for (const [key, value] of Object.entries(args)) {
    if (key.startsWith('filters.')) {
      const field = key.slice('filters.'.length).trim();
      if (field) {
        filters[field] = value;
      }
    }
  }

  const propertyType = readFirstArg(args, ['filters.propertyType', 'propertyType']);
  if (propertyType !== undefined) {
    filters.propertyType = propertyType;
  }

  const municipality = readFirstArg(args, ['filters.municipality', 'municipality']);
  if (municipality !== undefined) {
    filters.municipality = municipality;
  }

  return filters;
}

function timestamp() {
  return new Date().toISOString();
}

function logInfo(message, details) {
  if (details === undefined) {
    console.log(`[${timestamp()}] ${message}`);
    return;
  }
  console.log(`[${timestamp()}] ${message}`, details);
}

function logError(message, error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[${timestamp()}] ${message}: ${detail}`);
}

function parsePort(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return null;
  }
  const port = Number(rawValue);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid health port "${rawValue}". Use an integer between 1 and 65535.`);
  }
  return port;
}

function createHealthServer(port, state) {
  const server = http.createServer((req, res) => {
    if (!req.url || (req.url !== '/health' && req.url !== '/healthz')) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'ok',
      now: timestamp(),
      lastSuccessfulRun: state.lastSuccessfulRun,
    }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function extractScrapeParams(args) {
  const filters = extractFilters(args);
  return {
    ...filters,
    maxPages: readFirstArg(args, ['max-pages', 'maxPages']),
    headless: toBoolean(args.headless, true),
  };
}

async function runSitePipeline(options) {
  const {
    pipeline,
    store,
    siteId,
    scrapeParams,
    maxMissCount,
    dbDryRun,
  } = options;

  const startedAt = timestamp();
  logInfo(`Starting scrape for site "${siteId}"`);

  const listings = await pipeline.scrape(siteId, scrapeParams);
  const persistReport = await store.persistRun({
    siteId,
    listings,
    dryRun: dbDryRun,
    maxMissCount,
    startedAt,
    finishedAt: timestamp(),
    dualWriteLegacy: true,
  });

  const notificationResult = await notifyChanges({
    enabled: toBoolean(process.env.ENABLE_NOTIFICATIONS, false),
    dryRun: dbDryRun,
    siteId,
    report: persistReport,
    botToken: process.env.BOT_TOKEN,
    chatId: process.env.TELEGRAM_USER_ID,
  });

  if (!notificationResult.sent && notificationResult.reason === 'missing-credentials') {
    logInfo('Notifications enabled but BOT_TOKEN or TELEGRAM_USER_ID is missing.');
  }

  logInfo(`Finished site "${siteId}"`, {
    listingsFound: persistReport.listingsFound,
    totalChanges: persistReport.totalChanges,
    runId: persistReport.runId,
    dryRun: persistReport.dryRun,
    notification: notificationResult,
  });

  return {
    siteId,
    ok: true,
    finishedAt: timestamp(),
    report: persistReport,
  };
}

async function runAllSitesOnce(options) {
  const {
    pipeline,
    store,
    args,
    healthState,
  } = options;

  const siteIds = pipeline.listSites();
  const scrapeParams = extractScrapeParams(args);
  const maxMissCount = readFirstArg(args, ['max-miss-count']);
  const dbDryRun = false;
  const cycleStarted = timestamp();

  logInfo(`Starting run for ${siteIds.length} site(s).`, {
    mode: toBoolean(args.once, false) ? 'once' : 'schedule-tick',
    startedAt: cycleStarted,
  });

  let successCount = 0;
  let failureCount = 0;

  for (const siteId of siteIds) {
    try {
      const result = await runSitePipeline({
        pipeline,
        store,
        siteId,
        scrapeParams,
        maxMissCount,
        dbDryRun,
      });
      successCount += 1;
      healthState.lastSuccessfulRun = result.finishedAt;
    } catch (error) {
      failureCount += 1;
      logError(`Site "${siteId}" failed`, error);
    }
  }

  logInfo('Cycle completed.', {
    startedAt: cycleStarted,
    finishedAt: timestamp(),
    successCount,
    failureCount,
  });

  return {
    successCount,
    failureCount,
  };
}

function isScheduleMode(args) {
  return args.schedule !== undefined;
}

async function runSingleSiteCommand(options) {
  const { pipeline, args } = options;
  const site = args.site;

  if (!site || typeof site !== 'string') {
    printHelp(pipeline.listSites());
    process.exitCode = 1;
    return;
  }

  let store;
  try {
    const scrapeParams = extractScrapeParams(args);
    const startedAt = timestamp();
    const results = await pipeline.scrape(site, scrapeParams);

    const shouldPersist = toBoolean(args.persist, false) || toBoolean(args['dry-run'], false);
    if (shouldPersist) {
      store = await createListingsStore({ dbUrl: args.db });
      const persistReport = await store.persistRun({
        siteId: site,
        listings: results,
        dryRun: toBoolean(args['dry-run'], false),
        maxMissCount: readFirstArg(args, ['max-miss-count']),
        startedAt,
        finishedAt: timestamp(),
        dualWriteLegacy: true,
      });

      if (persistReport.dryRun) {
        console.error(JSON.stringify({
          dryRun: true,
          summary: {
            runId: persistReport.runId,
            listingsFound: persistReport.listingsFound,
            newCount: persistReport.newCount,
            priceChangedCount: persistReport.priceChangedCount,
            attributesChangedCount: persistReport.attributesChangedCount,
            removedCount: persistReport.removedCount,
            reappearedCount: persistReport.reappearedCount,
            totalChanges: persistReport.totalChanges,
          },
          changes: persistReport.changes,
        }, null, 2));
      } else {
        const notificationResult = await notifyChanges({
          enabled: toBoolean(process.env.ENABLE_NOTIFICATIONS, false),
          dryRun: toBoolean(args['dry-run'], false),
          siteId: site,
          report: persistReport,
          botToken: process.env.BOT_TOKEN,
          chatId: process.env.TELEGRAM_USER_ID,
        });

        if (!notificationResult.sent && notificationResult.reason === 'missing-credentials') {
          console.error('Notifications enabled but BOT_TOKEN or TELEGRAM_USER_ID is missing.');
        }
      }
    }

    const json = JSON.stringify(results, null, 2);
    if (args.out && typeof args.out === 'string') {
      const outputPath = path.resolve(process.cwd(), args.out);
      await fs.writeFile(outputPath, json + '\n', 'utf-8');
    }

    console.log(json);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (store) {
      await store.close();
    }
  }
}

async function runSchedulerCommand(options) {
  const { pipeline, args } = options;
  const healthState = {
    lastSuccessfulRun: null,
  };

  let healthServer;
  let store;
  let task;

  try {
    const healthPort = parsePort(readFirstArg(args, ['health-port']) || process.env.HEALTH_PORT);
    if (healthPort) {
      healthServer = await createHealthServer(healthPort, healthState);
      logInfo(`Health endpoint listening on http://localhost:${healthPort}/health`);
    }

    store = await createListingsStore({ dbUrl: args.db });

    if (toBoolean(args.once, false)) {
      const result = await runAllSitesOnce({ pipeline, store, args, healthState });
      if (result.failureCount > 0) {
        process.exitCode = 1;
      }
      return;
    }

    const cronExpr = typeof args.schedule === 'string' && args.schedule.trim()
      ? args.schedule.trim()
      : process.env.SCRAPE_CRON;

    if (!cronExpr) {
      throw new Error('Missing schedule expression. Pass --schedule "<cron>" or set SCRAPE_CRON in .env.');
    }

    if (!cron.validate(cronExpr)) {
      throw new Error(`Invalid cron expression: "${cronExpr}".`);
    }

    let cycleRunning = false;
    const runCycle = async () => {
      if (cycleRunning) {
        logInfo('Previous cycle is still running. Skipping this tick.');
        return;
      }

      cycleRunning = true;
      try {
        await runAllSitesOnce({ pipeline, store, args, healthState });
      } catch (error) {
        // Extra safety net. Per-site failures are already handled in runAllSitesOnce.
        logError('Unexpected cycle failure', error);
      } finally {
        cycleRunning = false;
      }
    };

    task = cron.schedule(cronExpr, () => {
      void runCycle();
    });

    logInfo(`Scheduler started with cron "${cronExpr}".`);

    const shutdown = async (signal) => {
      logInfo(`Received ${signal}. Shutting down scheduler...`);
      if (task) {
        task.stop();
      }
      if (healthServer) {
        await new Promise((resolve) => healthServer.close(resolve));
      }
      if (store) {
        await store.close();
      }
      process.exit(0);
    };

    process.on('SIGINT', () => {
      void shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM');
    });
  } catch (error) {
    logError('Scheduler setup failed', error);
    if (task) {
      task.stop();
    }
    if (healthServer) {
      await new Promise((resolve) => healthServer.close(resolve));
    }
    if (store) {
      await store.close();
    }
    process.exitCode = 1;
  } finally {
    if (toBoolean(args.once, false)) {
      if (healthServer) {
        await new Promise((resolve) => healthServer.close(resolve));
      }
      if (store) {
        await store.close();
      }
    }
  }
}

(async () => {
  const pipeline = createPipeline(adapters);
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp(pipeline.listSites());
    return;
  }

  if (toBoolean(args.status, false)) {
    const store = await createListingsStore({ dbUrl: args.db });
    try {
      const status = await store.getStatus(args.site);
      console.log(JSON.stringify(status, null, 2));
    } finally {
      await store.close();
    }
    return;
  }

  if (toBoolean(args.once, false) || isScheduleMode(args)) {
    await runSchedulerCommand({ pipeline, args });
    return;
  }

  await runSingleSiteCommand({ pipeline, args });
})();

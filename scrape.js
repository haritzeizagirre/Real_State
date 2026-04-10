#!/usr/bin/env node
require('dotenv').config({ quiet: true });
const fs = require('fs/promises');
const path = require('path');
const { adapters } = require('./src/adapters');
const { createPipeline } = require('./src/core/pipeline');
const { createListingsStore, DEFAULT_MAX_MISS_COUNT } = require('./src/core/turso-store');

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
    '',
    'Main commands:',
    '  --site <id>                 Site adapter id to execute',
    '  --status                    Show database status (without scraping)',
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

(async () => {
  const pipeline = createPipeline(adapters);
  const args = parseArgs(process.argv.slice(2));
  let store;

  if (args.help) {
    printHelp(pipeline.listSites());
    return;
  }

  if (toBoolean(args.status, false)) {
    store = await createListingsStore({ dbUrl: args.db });
    const status = await store.getStatus(args.site);
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  const site = args.site;
  if (!site || typeof site !== 'string') {
    printHelp(pipeline.listSites());
    process.exitCode = 1;
    return;
  }

  try {
    const filters = extractFilters(args);
    const startedAt = new Date().toISOString();
    const results = await pipeline.scrape(site, {
      ...filters,
      maxPages: readFirstArg(args, ['max-pages', 'maxPages']),
      headless: toBoolean(args.headless, true),
    });

    const shouldPersist = toBoolean(args.persist, false) || toBoolean(args['dry-run'], false);
    if (shouldPersist) {
      store = await createListingsStore({ dbUrl: args.db });
      const persistReport = await store.persistRun({
        siteId: site,
        listings: results,
        dryRun: toBoolean(args['dry-run'], false),
        maxMissCount: readFirstArg(args, ['max-miss-count']),
        startedAt,
        finishedAt: new Date().toISOString(),
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
})();

#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { adapters } = require('./adapters');
const { createPipeline } = require('./core/pipeline');

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
    'Usage: node scrape.js --site <siteId> [options]',
    '',
    'Required:',
    '  --site <id>                 Site adapter id to execute',
    '',
    'Optional:',
    '  --out <file>                Write JSON output to file',
    '  --propertyType <value>      Default: piso',
    '  --municipality <value>      Default: Hendaye',
    '  --maxPages <number>         Default: 25',
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

(async () => {
  const pipeline = createPipeline(adapters);
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp(pipeline.listSites());
    return;
  }

  const site = args.site;
  if (!site || typeof site !== 'string') {
    printHelp(pipeline.listSites());
    process.exitCode = 1;
    return;
  }

  try {
    const results = await pipeline.scrape(site, {
      propertyType: args.propertyType,
      municipality: args.municipality,
      maxPages: args.maxPages,
      headless: toBoolean(args.headless, true),
    });

    const json = JSON.stringify(results, null, 2);
    if (args.out && typeof args.out === 'string') {
      const outputPath = path.resolve(process.cwd(), args.out);
      await fs.writeFile(outputPath, json + '\n', 'utf-8');
    }

    console.log(json);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
})();

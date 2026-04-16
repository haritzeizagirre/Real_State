const {
  DEFAULT_MAX_MISS_COUNT,
  normalizeListing,
  detectChanges,
} = require('./monitoring');

const MAX_REASONABLE_PRICE_NUM = 50000000;

/** @typedef {import('./types').PersistRunParams} PersistRunParams */
/** @typedef {import('./types').PersistRunReport} PersistRunReport */

/**
 * @param {{dbUrl?: string}} [options]
 * @returns {{url: string, authToken: string}}
 */
function readConfig(options = {}) {
  const url = options.dbUrl || process.env.TURSO_DB || process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_TOKEN || process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    throw new Error('Missing Turso URL. Set TURSO_DB or pass --db <url>.');
  }

  if (!authToken) {
    throw new Error('Missing Turso token. Set TURSO_TOKEN.');
  }

  return { url, authToken };
}

/**
 * @param {unknown} row
 * @param {string} key
 * @param {number} index
 * @param {unknown} [fallback]
 * @returns {unknown}
 */
function readRowField(row, key, index, fallback = null) {
  if (!row) {
    return fallback;
  }
  if (typeof row === 'object' && !Array.isArray(row) && row[key] !== undefined) {
    return row[key];
  }
  if (Array.isArray(row) && row[index] !== undefined) {
    return row[index];
  }
  return fallback;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function sanitizePriceNumForStorage(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const rounded = Math.round(parsed);
  if (!Number.isSafeInteger(rounded) || rounded <= 0 || rounded > MAX_REASONABLE_PRICE_NUM) {
    return null;
  }

  return rounded;
}

/**
 * @param {unknown} client
 * @param {string} tableName
 * @returns {Promise<Set<string>>}
 */
async function readTableColumns(client, tableName) {
  const result = await client.execute(`PRAGMA table_info(${tableName})`);
  const columns = new Set();

  for (const row of result.rows) {
    const name = String(readRowField(row, 'name', 1, '') || '').trim();
    if (name) {
      columns.add(name);
    }
  }

  return columns;
}

/**
 * @param {unknown} client
 * @param {string} tableName
 * @param {Array<{name: string, definition: string}>} columns
 * @returns {Promise<void>}
 */
async function ensureColumns(client, tableName, columns) {
  const existing = await readTableColumns(client, tableName);

  for (const column of columns) {
    if (existing.has(column.name)) {
      continue;
    }

    await client.execute(`ALTER TABLE ${tableName} ADD COLUMN ${column.definition}`);
  }
}

/**
 * @param {unknown} client
 * @returns {Promise<void>}
 */
async function ensureSchema(client) {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS scrape_runs (
      run_id INTEGER PRIMARY KEY AUTOINCREMENT,
      siteId TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      listings_found INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok'
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS listings_current (
      siteId TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      title TEXT,
      title_norm TEXT,
      location TEXT,
      location_norm TEXT,
      price TEXT,
      price_num INTEGER,
      detailUrl TEXT,
      reference TEXT,
      description TEXT,
      transactionType TEXT,
      size TEXT,
      bedrooms INTEGER,
      bathrooms INTEGER,
      garages INTEGER,
      imageUrl TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      miss_count INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      removed_at TEXT,
      PRIMARY KEY (siteId, listing_id)
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS listings_snapshot (
      run_id INTEGER NOT NULL,
      siteId TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      title TEXT,
      location TEXT,
      price TEXT,
      price_num INTEGER,
      detailUrl TEXT,
      reference TEXT,
      description TEXT,
      transactionType TEXT,
      size TEXT,
      bedrooms INTEGER,
      bathrooms INTEGER,
      garages INTEGER,
      imageUrl TEXT,
      scrapedAt TEXT,
      PRIMARY KEY (run_id, siteId, listing_id),
      FOREIGN KEY (run_id) REFERENCES scrape_runs(run_id)
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS listing_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      siteId TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES scrape_runs(run_id)
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS apartments (
      id TEXT PRIMARY KEY,
      title TEXT,
      location TEXT,
      price TEXT,
      detailUrl TEXT,
      reference TEXT,
      description TEXT,
      transactionType TEXT,
      size TEXT,
      bedrooms INTEGER,
      bathrooms INTEGER,
      garages INTEGER,
      imageUrl TEXT,
      scrapedAt TEXT,
      siteId TEXT,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumns(client, 'listings_current', [
    { name: 'reference', definition: 'reference TEXT' },
    { name: 'description', definition: 'description TEXT' },
    { name: 'transactionType', definition: 'transactionType TEXT' },
    { name: 'size', definition: 'size TEXT' },
    { name: 'bedrooms', definition: 'bedrooms INTEGER' },
    { name: 'bathrooms', definition: 'bathrooms INTEGER' },
    { name: 'garages', definition: 'garages INTEGER' },
    { name: 'imageUrl', definition: 'imageUrl TEXT' },
  ]);

  await ensureColumns(client, 'listings_snapshot', [
    { name: 'reference', definition: 'reference TEXT' },
    { name: 'description', definition: 'description TEXT' },
    { name: 'transactionType', definition: 'transactionType TEXT' },
    { name: 'size', definition: 'size TEXT' },
    { name: 'bedrooms', definition: 'bedrooms INTEGER' },
    { name: 'bathrooms', definition: 'bathrooms INTEGER' },
    { name: 'garages', definition: 'garages INTEGER' },
    { name: 'imageUrl', definition: 'imageUrl TEXT' },
  ]);

  await ensureColumns(client, 'apartments', [
    { name: 'reference', definition: 'reference TEXT' },
    { name: 'description', definition: 'description TEXT' },
    { name: 'transactionType', definition: 'transactionType TEXT' },
    { name: 'size', definition: 'size TEXT' },
    { name: 'bedrooms', definition: 'bedrooms INTEGER' },
    { name: 'bathrooms', definition: 'bathrooms INTEGER' },
    { name: 'garages', definition: 'garages INTEGER' },
    { name: 'imageUrl', definition: 'imageUrl TEXT' },
  ]);

  // Defensively clear legacy malformed values that can break JS integer decoding.
  for (const tableName of ['listings_current', 'listings_snapshot']) {
    await client.execute({
      sql: `
        UPDATE ${tableName}
        SET price_num = NULL
        WHERE price_num IS NOT NULL
          AND (price_num <= 0 OR price_num > ?)
      `,
      args: [MAX_REASONABLE_PRICE_NUM],
    });
  }

  await client.execute('CREATE INDEX IF NOT EXISTS idx_scrape_runs_site ON scrape_runs(siteId, run_id DESC)');
  await client.execute('CREATE INDEX IF NOT EXISTS idx_listings_current_site_active ON listings_current(siteId, is_active, miss_count DESC)');
  await client.execute('CREATE INDEX IF NOT EXISTS idx_listings_snapshot_site_run ON listings_snapshot(siteId, run_id DESC)');
  await client.execute('CREATE INDEX IF NOT EXISTS idx_listing_changes_site_run ON listing_changes(siteId, run_id DESC)');
}

/**
 * @param {{dbUrl?: string}} [options]
 */
async function createListingsStore(options = {}) {
  const { createClient } = await import('@tursodatabase/serverless/compat');
  const config = readConfig(options);
  const client = createClient(config);

  await ensureSchema(client);

  async function readCurrentRows(siteId) {
    const result = await client.execute({
      sql: `
        SELECT
          siteId,
          listing_id,
          title,
          title_norm,
          location,
          location_norm,
          price,
          price_num,
          detailUrl,
          reference,
          description,
          transactionType,
          size,
          bedrooms,
          bathrooms,
          garages,
          imageUrl,
          first_seen,
          last_seen,
          miss_count,
          is_active,
          removed_at
        FROM listings_current
        WHERE siteId = ?
      `,
      args: [siteId],
    });

    const map = new Map();
    for (const row of result.rows) {
      const asText = (key, index) => {
        const value = readRowField(row, key, index, '');
        return value === null || value === undefined ? '' : String(value);
      };

      const normalized = {
        siteId: asText('siteId', 0),
        listing_id: asText('listing_id', 1),
        title: asText('title', 2),
        title_norm: asText('title_norm', 3),
        location: asText('location', 4),
        location_norm: asText('location_norm', 5),
        price: asText('price', 6),
        price_num: readRowField(row, 'price_num', 7, null),
        detailUrl: asText('detailUrl', 8),
        reference: asText('reference', 9),
        description: asText('description', 10),
        transactionType: asText('transactionType', 11),
        size: asText('size', 12),
        bedrooms: readRowField(row, 'bedrooms', 13, null),
        bathrooms: readRowField(row, 'bathrooms', 14, null),
        garages: readRowField(row, 'garages', 15, null),
        imageUrl: asText('imageUrl', 16),
        first_seen: asText('first_seen', 17),
        last_seen: asText('last_seen', 18),
        miss_count: Number(readRowField(row, 'miss_count', 19, 0)),
        is_active: Number(readRowField(row, 'is_active', 20, 1)),
        removed_at: readRowField(row, 'removed_at', 21, null),
      };
      map.set(normalized.listing_id, normalized);
    }
    return map;
  }

  async function createRun(siteId, startedAt, status = 'ok', finishedAt = null, listingsFound = 0) {
    await client.execute({
      sql: `
        INSERT INTO scrape_runs (siteId, started_at, finished_at, listings_found, status)
        VALUES (?, ?, ?, ?, ?)
      `,
      args: [siteId, startedAt, finishedAt, listingsFound, status],
    });

    const runResult = await client.execute('SELECT last_insert_rowid() AS run_id');
    const row = runResult.rows[0] || {};
    return Number(readRowField(row, 'run_id', 0, 0));
  }

  async function finalizeRun(runId, finishedAt, listingsFound, status) {
    await client.execute({
      sql: `
        UPDATE scrape_runs
        SET finished_at = ?, listings_found = ?, status = ?
        WHERE run_id = ?
      `,
      args: [finishedAt, listingsFound, status, runId],
    });
  }

  async function closeOpenPartialRuns(siteId, finishedAt) {
    await client.execute({
      sql: `
        UPDATE scrape_runs
        SET finished_at = ?, status = 'failed'
        WHERE siteId = ?
          AND status = 'partial'
          AND finished_at IS NULL
      `,
      args: [finishedAt, siteId],
    });
  }

  async function writeSnapshots(runId, rows) {
    for (const row of rows) {
      await client.execute({
        sql: `
          INSERT OR REPLACE INTO listings_snapshot (
            run_id,
            siteId,
            listing_id,
            title,
            location,
            price,
            price_num,
            detailUrl,
            reference,
            description,
            transactionType,
            size,
            bedrooms,
            bathrooms,
            garages,
            imageUrl,
            scrapedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          runId,
          row.siteId,
          row.id,
          row.title,
          row.location,
          row.price,
          sanitizePriceNumForStorage(row.priceNum),
          row.detailUrl,
          row.reference,
          row.description,
          row.transactionType,
          row.size,
          row.bedrooms,
          row.bathrooms,
          row.garages,
          row.imageUrl,
          row.scrapedAt,
        ],
      });
    }
  }

  async function writeCurrentRows(rows) {
    for (const row of rows) {
      await client.execute({
        sql: `
          INSERT INTO listings_current (
            siteId,
            listing_id,
            title,
            title_norm,
            location,
            location_norm,
            price,
            price_num,
            detailUrl,
            reference,
            description,
            transactionType,
            size,
            bedrooms,
            bathrooms,
            garages,
            imageUrl,
            first_seen,
            last_seen,
            miss_count,
            is_active,
            removed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(siteId, listing_id) DO UPDATE SET
            title = excluded.title,
            title_norm = excluded.title_norm,
            location = excluded.location,
            location_norm = excluded.location_norm,
            price = excluded.price,
            price_num = excluded.price_num,
            detailUrl = excluded.detailUrl,
            reference = excluded.reference,
            description = excluded.description,
            transactionType = excluded.transactionType,
            size = excluded.size,
            bedrooms = excluded.bedrooms,
            bathrooms = excluded.bathrooms,
            garages = excluded.garages,
            imageUrl = excluded.imageUrl,
            first_seen = excluded.first_seen,
            last_seen = excluded.last_seen,
            miss_count = excluded.miss_count,
            is_active = excluded.is_active,
            removed_at = excluded.removed_at
        `,
        args: [
          row.siteId,
          row.id,
          row.title,
          row.titleNorm,
          row.location,
          row.locationNorm,
          row.price,
          sanitizePriceNumForStorage(row.priceNum),
          row.detailUrl,
          row.reference,
          row.description,
          row.transactionType,
          row.size,
          row.bedrooms,
          row.bathrooms,
          row.garages,
          row.imageUrl,
          row.firstSeen,
          row.lastSeen,
          row.missCount,
          row.isActive,
          row.removedAt,
        ],
      });
    }
  }

  async function applyMissingUpdates(rows) {
    for (const row of rows) {
      await client.execute({
        sql: `
          UPDATE listings_current
          SET miss_count = ?, is_active = ?, removed_at = ?
          WHERE siteId = ? AND listing_id = ?
        `,
        args: [row.missCount, row.isActive, row.removedAt, row.siteId, row.listingId],
      });
    }
  }

  async function writeChanges(runId, siteId, events, createdAt) {
    for (const event of events) {
      await client.execute({
        sql: `
          INSERT INTO listing_changes (run_id, siteId, listing_id, change_type, diff_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        args: [runId, siteId, event.listingId, event.changeType, JSON.stringify(event.diff), createdAt],
      });
    }
  }

  async function writeLegacyApartments(rows) {
    for (const row of rows) {
      await client.execute({
        sql: `
          INSERT INTO apartments (
            id,
            title,
            location,
            price,
            detailUrl,
            reference,
            description,
            transactionType,
            size,
            bedrooms,
            bathrooms,
            garages,
            imageUrl,
            scrapedAt,
            siteId
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            location = excluded.location,
            price = excluded.price,
            detailUrl = excluded.detailUrl,
            reference = excluded.reference,
            description = excluded.description,
            transactionType = excluded.transactionType,
            size = excluded.size,
            bedrooms = excluded.bedrooms,
            bathrooms = excluded.bathrooms,
            garages = excluded.garages,
            imageUrl = excluded.imageUrl,
            scrapedAt = excluded.scrapedAt,
            siteId = excluded.siteId,
            updatedAt = CURRENT_TIMESTAMP
        `,
        args: [
          row.id,
          row.title,
          row.location,
          row.price,
          row.detailUrl,
          row.reference,
          row.description,
          row.transactionType,
          row.size,
          row.bedrooms,
          row.bathrooms,
          row.garages,
          row.imageUrl,
          row.scrapedAt,
          row.siteId,
        ],
      });
    }
  }

  return {
    url: config.url,

    /**
     * @param {PersistRunParams} [params]
     * @returns {Promise<PersistRunReport>}
     */
    async persistRun(params = {}) {
      const siteId = String(params.siteId || '').trim();
      if (!siteId) {
        throw new Error('persistRun requires siteId.');
      }

      const inputRows = Array.isArray(params.listings) ? params.listings : [];
      const normalizedListings = inputRows.map(normalizeListing).filter((row) => row.siteId === siteId);
      const maxMissCount = Number.isFinite(Number(params.maxMissCount))
        ? Math.max(1, Number(params.maxMissCount))
        : DEFAULT_MAX_MISS_COUNT;
      const dryRun = Boolean(params.dryRun);
      const startedAt = params.startedAt || new Date().toISOString();
      const finishedAt = params.finishedAt || new Date().toISOString();
      const nowIso = finishedAt;

      const previousMap = await readCurrentRows(siteId);
      const detection = detectChanges(previousMap, normalizedListings, maxMissCount, nowIso);

      if (dryRun) {
        return {
          dryRun: true,
          maxMissCount,
          runId: null,
          ...detection.summary,
          totalChanges: detection.events.length,
          changes: detection.events,
        };
      }

      let runId;
      try {
        await closeOpenPartialRuns(siteId, startedAt);
        runId = await createRun(siteId, startedAt, 'partial', null, 0);

        await writeSnapshots(runId, normalizedListings);
        await writeCurrentRows(detection.upsertsCurrent);
        await applyMissingUpdates(detection.missingUpdates);
        await writeChanges(runId, siteId, detection.events, nowIso);

        if (params.dualWriteLegacy !== false) {
          await writeLegacyApartments(normalizedListings);
        }

        await finalizeRun(runId, finishedAt, detection.summary.listingsFound, 'ok');
      } catch (error) {
        if (runId) {
          await finalizeRun(runId, nowIso, detection.summary.listingsFound, 'failed');
        }
        throw error;
      }

      return {
        dryRun: false,
        runId,
        maxMissCount,
        ...detection.summary,
        totalChanges: detection.events.length,
        changes: detection.events,
      };
    },

    /**
     * @param {string} [siteId]
     * @returns {Promise<Record<string, unknown>>}
     */
    async getStatus(siteId) {
      const whereClause = siteId ? 'WHERE siteId = ?' : '';
      const args = siteId ? [siteId] : [];

      const countsResult = await client.execute({
        sql: `
          SELECT
            COUNT(*) AS total_known,
            SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_count,
            SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS removed_count,
            SUM(CASE WHEN is_active = 1 AND miss_count > 0 THEN 1 ELSE 0 END) AS pending_miss_count,
            MAX(last_seen) AS latest_seen_at
          FROM listings_current
          ${whereClause}
        `,
        args,
      });

      const latestRunResult = await client.execute({
        sql: `
          SELECT run_id, siteId, started_at, finished_at, listings_found, status
          FROM scrape_runs
          ${whereClause}
          ORDER BY run_id DESC
          LIMIT 1
        `,
        args,
      });

      const counts = countsResult.rows[0] || {};
      const latestRunRow = latestRunResult.rows[0] || null;

      const latestRun = latestRunRow
        ? {
          runId: Number(readRowField(latestRunRow, 'run_id', 0, 0)),
          siteId: String(readRowField(latestRunRow, 'siteId', 1, '')),
          startedAt: readRowField(latestRunRow, 'started_at', 2, null),
          finishedAt: readRowField(latestRunRow, 'finished_at', 3, null),
          listingsFound: Number(readRowField(latestRunRow, 'listings_found', 4, 0)),
          status: String(readRowField(latestRunRow, 'status', 5, 'unknown')),
        }
        : null;

      return {
        backend: 'turso',
        url: config.url,
        siteId: siteId || null,
        maxMissCountDefault: DEFAULT_MAX_MISS_COUNT,
        totals: {
          known: Number(readRowField(counts, 'total_known', 0, 0)),
          active: Number(readRowField(counts, 'active_count', 1, 0)),
          removed: Number(readRowField(counts, 'removed_count', 2, 0)),
          pendingMiss: Number(readRowField(counts, 'pending_miss_count', 3, 0)),
          latestSeenAt: readRowField(counts, 'latest_seen_at', 4, null),
        },
        latestRun,
      };
    },

    async close() {
      await client.close();
    },
  };
}

module.exports = {
  createListingsStore,
  DEFAULT_MAX_MISS_COUNT,
};

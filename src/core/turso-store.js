const {
  DEFAULT_MAX_MISS_COUNT,
  normalizeListing,
  detectChanges,
} = require('./monitoring');

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
      scrapedAt TEXT,
      siteId TEXT,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

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
      const normalized = {
        siteId: String(readRowField(row, 'siteId', 0, siteId)),
        listing_id: String(readRowField(row, 'listing_id', 1, '')),
        title: String(readRowField(row, 'title', 2, '')),
        title_norm: String(readRowField(row, 'title_norm', 3, '')),
        location: String(readRowField(row, 'location', 4, '')),
        location_norm: String(readRowField(row, 'location_norm', 5, '')),
        price: String(readRowField(row, 'price', 6, '')),
        price_num: readRowField(row, 'price_num', 7, null),
        detailUrl: String(readRowField(row, 'detailUrl', 8, '')),
        first_seen: String(readRowField(row, 'first_seen', 9, '')),
        last_seen: String(readRowField(row, 'last_seen', 10, '')),
        miss_count: Number(readRowField(row, 'miss_count', 11, 0)),
        is_active: Number(readRowField(row, 'is_active', 12, 1)),
        removed_at: readRowField(row, 'removed_at', 13, null),
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
            scrapedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          runId,
          row.siteId,
          row.id,
          row.title,
          row.location,
          row.price,
          row.priceNum,
          row.detailUrl,
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
            first_seen,
            last_seen,
            miss_count,
            is_active,
            removed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(siteId, listing_id) DO UPDATE SET
            title = excluded.title,
            title_norm = excluded.title_norm,
            location = excluded.location,
            location_norm = excluded.location_norm,
            price = excluded.price,
            price_num = excluded.price_num,
            detailUrl = excluded.detailUrl,
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
          row.priceNum,
          row.detailUrl,
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
          INSERT INTO apartments (id, title, location, price, detailUrl, scrapedAt, siteId)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            location = excluded.location,
            price = excluded.price,
            detailUrl = excluded.detailUrl,
            scrapedAt = excluded.scrapedAt,
            siteId = excluded.siteId,
            updatedAt = CURRENT_TIMESTAMP
        `,
        args: [row.id, row.title, row.location, row.price, row.detailUrl, row.scrapedAt, row.siteId],
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

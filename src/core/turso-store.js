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

async function createListingsStore(options = {}) {
  const { createClient } = await import('@tursodatabase/serverless/compat');
  const config = readConfig(options);
  const client = createClient(config);

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

  return {
    url: config.url,

    async upsertMany(rows = []) {
      if (!Array.isArray(rows)) {
        throw new Error('upsertMany expects an array.');
      }

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
          args: [
            String(row.id),
            row.title ?? null,
            row.location ?? null,
            row.price ?? null,
            row.detailUrl ?? null,
            row.scrapedAt ?? null,
            row.siteId ?? null,
          ],
        });
      }

      const summaryResult = await client.execute('SELECT COUNT(*) AS totalRows, MAX(scrapedAt) AS latestScrapedAt FROM apartments');
      const summary = summaryResult.rows[0] || {};

      return {
        upserted: rows.length,
        totalRows: Number(summary.totalRows || 0),
        latestScrapedAt: summary.latestScrapedAt || null,
      };
    },

    async getStatus() {
      const summaryResult = await client.execute('SELECT COUNT(*) AS totalRows, MAX(scrapedAt) AS latestScrapedAt FROM apartments');
      const summary = summaryResult.rows[0] || {};
      return {
        backend: 'turso',
        url: config.url,
        table: 'apartments',
        totalRows: Number(summary.totalRows || 0),
        latestScrapedAt: summary.latestScrapedAt || null,
      };
    },

    async close() {
      await client.close();
    },
  };
}

module.exports = {
  createListingsStore,
};

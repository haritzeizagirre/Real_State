const path = require('path');
const express = require('express');

const PRICE_NUM_MIN = 1000;
const PRICE_NUM_MAX = 5000000;

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

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parsePriceFromText(rawPrice) {
  const source = String(rawPrice || '').trim();
  if (!source) {
    return null;
  }

  const candidates = source.match(/\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d{4,}/g);
  if (!candidates || candidates.length === 0) {
    return null;
  }

  const token = candidates[candidates.length - 1];
  if (!token) {
    return null;
  }

  let normalized = token;
  const hasComma = normalized.includes(',');
  const hasDot = normalized.includes('.');

  if (hasComma && hasDot) {
    const lastComma = normalized.lastIndexOf(',');
    const lastDot = normalized.lastIndexOf('.');
    if (lastComma > lastDot) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = normalized.replace(/,/g, '');
    }
  } else if (hasComma) {
    normalized = /,\d{1,2}$/.test(normalized)
      ? normalized.replace(',', '.')
      : normalized.replace(/,/g, '');
  } else if (hasDot) {
    normalized = /\.\d{1,2}$/.test(normalized)
      ? normalized
      : normalized.replace(/\./g, '');
  }

  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.round(parsed);
}

function normalizePriceNumber(rawPriceNum, rawPriceText) {
  const direct = toNumber(rawPriceNum, null);
  if (direct !== null && direct >= 1000 && direct <= 5000000) {
    return Math.round(direct);
  }

  const parsed = parsePriceFromText(rawPriceText);
  if (parsed !== null && parsed >= 1000 && parsed <= 5000000) {
    return parsed;
  }

  return null;
}

function inferTransactionType(source) {
  const text = String(source || '').toLowerCase();
  if (/\b(alquiler|rent|to let|arrenda)\b/.test(text)) {
    return 'rent';
  }
  if (/\b(venta|sale|for sale|vender)\b/.test(text)) {
    return 'sale';
  }
  return 'unknown';
}

function inferBedrooms(source) {
  const text = String(source || '').toLowerCase();
  const patterns = [
    /(\d+)\s*(?:hab(?:itaciones?)?|habitacion(?:es)?|dorm(?:itorios?)?|bed(?:rooms?)?)/i,
    /\b(\d+)\s*habs?\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (Number.isInteger(value) && value >= 0 && value <= 20) {
        return value;
      }
    }
  }

  return null;
}

function normalizeFeatureCount(value) {
  const parsed = toNumber(value, null);
  if (parsed === null) {
    return null;
  }

  const rounded = Math.round(parsed);
  if (!Number.isInteger(rounded) || rounded < 0 || rounded > 20) {
    return null;
  }

  return rounded;
}

function normalizeTransactionTypeFilter(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) {
    return '';
  }

  if (text === 'sale' || text === 'rent' || text === 'unknown') {
    return text;
  }

  return '';
}

function parseDiffJson(raw) {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw;
  }

  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildListingFromRow(row) {
  const title = String(readRowField(row, 'title', 2, ''));
  const location = String(readRowField(row, 'location', 3, ''));
  const detailUrl = String(readRowField(row, 'detailUrl', 6, ''));
  const rawPrice = String(readRowField(row, 'price', 4, ''));
  const rawPriceNum = readRowField(row, 'price_num', 5, null);
  const size = String(readRowField(row, 'size', 9, '') || '').trim();
  const dbTransactionType = normalizeTransactionTypeFilter(readRowField(row, 'transactionType', 10, ''));
  const dbBedrooms = normalizeFeatureCount(readRowField(row, 'bedrooms', 11, null));
  const dbBathrooms = normalizeFeatureCount(readRowField(row, 'bathrooms', 12, null));

  return {
    siteId: String(readRowField(row, 'siteId', 0, '')),
    listingId: String(readRowField(row, 'listing_id', 1, '')),
    title,
    location,
    price: rawPrice,
    priceNum: normalizePriceNumber(rawPriceNum, rawPrice),
    size,
    detailUrl,
    firstSeen: String(readRowField(row, 'first_seen', 7, '')),
    lastSeen: String(readRowField(row, 'last_seen', 8, '')),
    transactionType: dbTransactionType || inferTransactionType(`${title} ${location} ${detailUrl}`),
    bedrooms: dbBedrooms !== null ? dbBedrooms : inferBedrooms(title),
    bathrooms: dbBathrooms,
  };
}

function sortListings(items, sortBy, sortDir) {
  const dir = sortDir === 'asc' ? 1 : -1;
  const safeSort = ['price_num', 'location', 'first_seen'].includes(sortBy) ? sortBy : 'first_seen';

  items.sort((a, b) => {
    if (safeSort === 'price_num') {
      const av = a.priceNum === null ? Number.POSITIVE_INFINITY : a.priceNum;
      const bv = b.priceNum === null ? Number.POSITIVE_INFINITY : b.priceNum;
      return av === bv ? 0 : av > bv ? dir : -dir;
    }

    if (safeSort === 'location') {
      const av = (a.location || '').toLowerCase();
      const bv = (b.location || '').toLowerCase();
      if (av === bv) {
        return 0;
      }
      return av > bv ? dir : -dir;
    }

    const av = Date.parse(a.firstSeen || '') || 0;
    const bv = Date.parse(b.firstSeen || '') || 0;
    if (av === bv) {
      return 0;
    }
    return av > bv ? dir : -dir;
  });
}

function computeHistogram(values, binCount = 8) {
  if (!values.length) {
    return [];
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [];
  }

  if (min === max) {
    return [{ min, max, count: values.length }];
  }

  const width = Math.ceil((max - min + 1) / binCount);
  const bins = Array.from({ length: binCount }, (_, index) => ({
    min: min + index * width,
    max: min + (index + 1) * width - 1,
    count: 0,
  }));

  for (const value of values) {
    const bucket = Math.min(binCount - 1, Math.floor((value - min) / width));
    bins[bucket].count += 1;
  }

  return bins;
}

function keyForHistory(siteId, listingId) {
  return `${siteId}::${listingId}`;
}

function parseHistoryIds(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return [];
  }

  const pairs = [];
  const seen = new Set();
  for (const item of text.split(',')) {
    const token = item.trim();
    if (!token) {
      continue;
    }

    const [siteId, listingId] = token.split('::');
    if (!siteId || !listingId) {
      continue;
    }

    const key = keyForHistory(siteId, listingId);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    pairs.push({ siteId, listingId });
  }

  return pairs.slice(0, 120);
}

async function startDashboardServer(options = {}) {
  const compatMod = await import('@tursodatabase/serverless/compat');
  const createClient = compatMod.createClient ?? compatMod.default?.createClient;
  if (typeof createClient !== 'function') {
    throw new Error('Could not resolve createClient from @tursodatabase/serverless/compat');
  }
  const config = readConfig(options);
  const client = createClient(config);
  const app = express();

  const port = Number(options.port) || 3000;
  const host = options.host || '0.0.0.0';
  const publicDir = path.join(__dirname, 'public');

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', backend: 'turso', url: config.url });
  });

  app.get('/api/options', async (_req, res) => {
    try {
      const sitesResult = await client.execute(`
        SELECT DISTINCT siteId
        FROM (
          SELECT siteId FROM listings_current
          UNION ALL
          SELECT siteId FROM scrape_runs
        )
        WHERE siteId IS NOT NULL AND siteId != ''
        ORDER BY siteId
      `);
      const rangesResult = await client.execute(`
        SELECT
          MIN(price_num) AS min_price,
          MAX(price_num) AS max_price
        FROM listings_current
        WHERE is_active = 1 AND price_num BETWEEN 1000 AND 5000000
      `);
      const bedroomValuesResult = await client.execute(`
        SELECT DISTINCT bedrooms
        FROM listings_current
        WHERE is_active = 1 AND bedrooms IS NOT NULL AND bedrooms >= 0 AND bedrooms <= 20
        ORDER BY bedrooms ASC
      `);
      const bathroomValuesResult = await client.execute(`
        SELECT DISTINCT bathrooms
        FROM listings_current
        WHERE is_active = 1 AND bathrooms IS NOT NULL AND bathrooms >= 0 AND bathrooms <= 20
        ORDER BY bathrooms ASC
      `);

      const sites = sitesResult.rows.map((row) => String(readRowField(row, 'siteId', 0, '') || '')).filter(Boolean);
      const rangesRow = rangesResult.rows[0] || {};
      const bedrooms = bedroomValuesResult.rows
        .map((row) => normalizeFeatureCount(readRowField(row, 'bedrooms', 0, null)))
        .filter((value) => value !== null);
      const bathrooms = bathroomValuesResult.rows
        .map((row) => normalizeFeatureCount(readRowField(row, 'bathrooms', 0, null)))
        .filter((value) => value !== null);

      res.json({
        sites,
        priceRange: {
          min: toNumber(readRowField(rangesRow, 'min_price', 0, null), null),
          max: toNumber(readRowField(rangesRow, 'max_price', 1, null), null),
        },
        bedrooms,
        bathrooms,
        transactionTypes: ['sale', 'rent', 'unknown'],
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/listings', async (req, res) => {
    try {
      const where = ['is_active = 1'];
      const args = [];

      if (req.query.site) {
        where.push('siteId = ?');
        args.push(String(req.query.site));
      }

      const sql = `
        SELECT
          siteId,
          listing_id,
          title,
          location,
          price,
          price_num,
          detailUrl,
          first_seen,
          last_seen,
          size,
          transactionType,
          bedrooms,
          bathrooms
        FROM listings_current
        WHERE ${where.join(' AND ')}
      `;

      const result = await client.execute({ sql, args });
      let items = result.rows.map(buildListingFromRow);

      const priceMin = toNumber(req.query.priceMin, null);
      if (priceMin !== null) {
        items = items.filter((item) => item.priceNum !== null && item.priceNum >= priceMin);
      }

      const priceMax = toNumber(req.query.priceMax, null);
      if (priceMax !== null) {
        items = items.filter((item) => item.priceNum !== null && item.priceNum <= priceMax);
      }

      const txType = String(req.query.transactionType || '').trim();
      if (txType) {
        items = items.filter((item) => item.transactionType === txType);
      }

      const bedrooms = toNumber(req.query.bedrooms, null);
      if (bedrooms !== null) {
        items = items.filter((item) => item.bedrooms === bedrooms);
      }

      const bathrooms = toNumber(req.query.bathrooms, null);
      if (bathrooms !== null) {
        items = items.filter((item) => item.bathrooms === bathrooms);
      }

      sortListings(items, String(req.query.sortBy || ''), String(req.query.sortDir || 'desc'));

      res.json({
        count: items.length,
        items,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/changes', async (req, res) => {
    try {
      const args = [];
      const where = [];

      const txType = normalizeTransactionTypeFilter(req.query.transactionType);
      const priceMin = toNumber(req.query.priceMin, null);
      const priceMax = toNumber(req.query.priceMax, null);
      const bedrooms = normalizeFeatureCount(req.query.bedrooms);
      const bathrooms = normalizeFeatureCount(req.query.bathrooms);

      if (req.query.site) {
        where.push('c.siteId = ?');
        args.push(String(req.query.site));
      }
      if (txType) {
        where.push(`COALESCE(cur.transactionType, snap.transactionType, '') = ?`);
        args.push(txType);
      }
      if (priceMin !== null) {
        where.push('COALESCE(cur.price_num, snap.price_num) >= ?');
        args.push(priceMin);
      }
      if (priceMax !== null) {
        where.push('COALESCE(cur.price_num, snap.price_num) <= ?');
        args.push(priceMax);
      }
      if (bedrooms !== null) {
        where.push('COALESCE(cur.bedrooms, snap.bedrooms) = ?');
        args.push(bedrooms);
      }
      if (bathrooms !== null) {
        where.push('COALESCE(cur.bathrooms, snap.bathrooms) = ?');
        args.push(bathrooms);
      }

      const limit = Math.max(10, Math.min(400, toNumber(req.query.limit, 120) || 120));
      args.push(limit);

      const sql = `
        SELECT
          c.change_id,
          c.run_id,
          c.siteId,
          c.listing_id,
          c.change_type,
          c.diff_json,
          c.created_at,
          COALESCE(cur.title, snap.title, '') AS title,
          COALESCE(cur.location, snap.location, '') AS location,
          COALESCE(cur.price, snap.price, '') AS price,
          COALESCE(cur.detailUrl, snap.detailUrl, '') AS detailUrl
        FROM listing_changes c
        LEFT JOIN listings_current cur
          ON cur.siteId = c.siteId AND cur.listing_id = c.listing_id
        LEFT JOIN listings_snapshot snap
          ON snap.run_id = c.run_id AND snap.siteId = c.siteId AND snap.listing_id = c.listing_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.change_id DESC
        LIMIT ?
      `;

      const result = await client.execute({ sql, args });
      const items = result.rows.map((row) => ({
        changeId: toNumber(readRowField(row, 'change_id', 0, 0), 0),
        runId: toNumber(readRowField(row, 'run_id', 1, 0), 0),
        siteId: String(readRowField(row, 'siteId', 2, '')),
        listingId: String(readRowField(row, 'listing_id', 3, '')),
        changeType: String(readRowField(row, 'change_type', 4, 'unknown')),
        diff: parseDiffJson(readRowField(row, 'diff_json', 5, '[]')),
        createdAt: String(readRowField(row, 'created_at', 6, '')),
        title: String(readRowField(row, 'title', 7, '')),
        location: String(readRowField(row, 'location', 8, '')),
        price: String(readRowField(row, 'price', 9, '')),
        detailUrl: String(readRowField(row, 'detailUrl', 10, '')),
      }));

      res.json({ count: items.length, items });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/summary', async (req, res) => {
    try {
      const site = String(req.query.site || '').trim();
      const txType = normalizeTransactionTypeFilter(req.query.transactionType);
      const priceMin = toNumber(req.query.priceMin, null);
      const priceMax = toNumber(req.query.priceMax, null);
      const bedrooms = normalizeFeatureCount(req.query.bedrooms);
      const bathrooms = normalizeFeatureCount(req.query.bathrooms);
      const activeArgs = [];
      const activeWhere = ['is_active = 1'];
      if (site) {
        activeWhere.push('siteId = ?');
        activeArgs.push(site);
      }
      if (txType) {
        activeWhere.push('transactionType = ?');
        activeArgs.push(txType);
      }
      if (priceMin !== null) {
        activeWhere.push('price_num >= ?');
        activeArgs.push(priceMin);
      }
      if (priceMax !== null) {
        activeWhere.push('price_num <= ?');
        activeArgs.push(priceMax);
      }
      if (bedrooms !== null) {
        activeWhere.push('bedrooms = ?');
        activeArgs.push(bedrooms);
      }
      if (bathrooms !== null) {
        activeWhere.push('bathrooms = ?');
        activeArgs.push(bathrooms);
      }

      const activeResult = await client.execute({
        sql: `
          SELECT
            COUNT(*) AS active_count,
            AVG(CASE WHEN price_num BETWEEN 1000 AND 5000000 THEN price_num END) AS avg_price
          FROM listings_current
          WHERE ${activeWhere.join(' AND ')}
        `,
        args: activeArgs,
      });

      const latestRunResult = await client.execute({
        sql: site
          ? 'SELECT run_id, siteId, started_at, finished_at, listings_found, status FROM scrape_runs WHERE siteId = ? ORDER BY run_id DESC LIMIT 1'
          : 'SELECT run_id, siteId, started_at, finished_at, listings_found, status FROM scrape_runs ORDER BY run_id DESC LIMIT 1',
        args: site ? [site] : [],
      });

      const latestRun = latestRunResult.rows[0] || null;
      let latestRunChanges = {
        new: 0,
        price_changed: 0,
        attributes_changed: 0,
        removed: 0,
        reappeared: 0,
      };

      if (latestRun) {
        const runId = toNumber(readRowField(latestRun, 'run_id', 0, 0), 0);
        const changesResult = await client.execute({
          sql: `
            SELECT c.change_type, COUNT(*) AS cnt
            FROM listing_changes c
            LEFT JOIN listings_current cur
              ON cur.siteId = c.siteId AND cur.listing_id = c.listing_id
            LEFT JOIN listings_snapshot snap
              ON snap.run_id = c.run_id AND snap.siteId = c.siteId AND snap.listing_id = c.listing_id
            WHERE c.run_id = ?
              ${txType ? "AND COALESCE(cur.transactionType, snap.transactionType, '') = ?" : ''}
              ${priceMin !== null ? 'AND COALESCE(cur.price_num, snap.price_num) >= ?' : ''}
              ${priceMax !== null ? 'AND COALESCE(cur.price_num, snap.price_num) <= ?' : ''}
              ${bedrooms !== null ? 'AND COALESCE(cur.bedrooms, snap.bedrooms) = ?' : ''}
              ${bathrooms !== null ? 'AND COALESCE(cur.bathrooms, snap.bathrooms) = ?' : ''}
            GROUP BY c.change_type
          `,
          args: [
            runId,
            ...(txType ? [txType] : []),
            ...(priceMin !== null ? [priceMin] : []),
            ...(priceMax !== null ? [priceMax] : []),
            ...(bedrooms !== null ? [bedrooms] : []),
            ...(bathrooms !== null ? [bathrooms] : []),
          ],
        });

        for (const row of changesResult.rows) {
          const key = String(readRowField(row, 'change_type', 0, ''));
          latestRunChanges[key] = toNumber(readRowField(row, 'cnt', 1, 0), 0);
        }
      }

      const timelineResult = await client.execute({
        sql: `
          SELECT
            s.run_id,
            r.siteId,
            r.started_at,
            r.finished_at,
            AVG(s.price_num) AS avg_price,
            COUNT(*) AS sample_size
          FROM listings_snapshot s
          JOIN scrape_runs r ON r.run_id = s.run_id
          WHERE s.price_num BETWEEN 1000 AND 5000000
          ${site ? 'AND r.siteId = ?' : ''}
          ${txType ? 'AND s.transactionType = ?' : ''}
          ${priceMin !== null ? 'AND s.price_num >= ?' : ''}
          ${priceMax !== null ? 'AND s.price_num <= ?' : ''}
          ${bedrooms !== null ? 'AND s.bedrooms = ?' : ''}
          ${bathrooms !== null ? 'AND s.bathrooms = ?' : ''}
          GROUP BY s.run_id, r.siteId, r.started_at, r.finished_at
          ORDER BY s.run_id DESC
          LIMIT 48
        `,
        args: [
          ...(site ? [site] : []),
          ...(txType ? [txType] : []),
          ...(priceMin !== null ? [priceMin] : []),
          ...(priceMax !== null ? [priceMax] : []),
          ...(bedrooms !== null ? [bedrooms] : []),
          ...(bathrooms !== null ? [bathrooms] : []),
        ],
      });

      const timeline = timelineResult.rows
        .map((row) => ({
          runId: toNumber(readRowField(row, 'run_id', 0, 0), 0),
          siteId: String(readRowField(row, 'siteId', 1, '')),
          startedAt: String(readRowField(row, 'started_at', 2, '')),
          finishedAt: String(readRowField(row, 'finished_at', 3, '')),
          avgPrice: toNumber(readRowField(row, 'avg_price', 4, null), null),
          sampleSize: toNumber(readRowField(row, 'sample_size', 5, 0), 0),
        }))
        .reverse();

      const histogramResult = await client.execute({
        sql: `
          SELECT price_num
          FROM listings_current
          WHERE ${activeWhere.join(' AND ')}
            AND price_num BETWEEN ? AND ?
        `,
        args: [...activeArgs, PRICE_NUM_MIN, PRICE_NUM_MAX],
      });

      const prices = histogramResult.rows
        .map((row) => toNumber(readRowField(row, 'price_num', 0, null), null))
        .filter((value) => value !== null);

      const activeRow = activeResult.rows[0] || {};
      res.json({
        totalActive: toNumber(readRowField(activeRow, 'active_count', 0, 0), 0),
        avgPriceCurrent: toNumber(readRowField(activeRow, 'avg_price', 1, null), null),
        latestRun: latestRun
          ? {
            runId: toNumber(readRowField(latestRun, 'run_id', 0, 0), 0),
            siteId: String(readRowField(latestRun, 'siteId', 1, '')),
            startedAt: String(readRowField(latestRun, 'started_at', 2, '')),
            finishedAt: String(readRowField(latestRun, 'finished_at', 3, '')),
            listingsFound: toNumber(readRowField(latestRun, 'listings_found', 4, 0), 0),
            status: String(readRowField(latestRun, 'status', 5, 'unknown')),
          }
          : null,
        latestRunChanges,
        avgPriceTimeline: timeline,
        priceHistogram: computeHistogram(prices),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/listing-histories', async (req, res) => {
    try {
      const pairs = parseHistoryIds(req.query.ids);
      if (!pairs.length) {
        res.json({ histories: {} });
        return;
      }

      const whereParts = [];
      const args = [];
      for (const pair of pairs) {
        whereParts.push('(siteId = ? AND listing_id = ?)');
        args.push(pair.siteId, pair.listingId);
      }

      const sql = `
        SELECT siteId, listing_id, run_id, price_num, price, scrapedAt
        FROM listings_snapshot
        WHERE (${whereParts.join(' OR ')}) AND price_num IS NOT NULL
        ORDER BY run_id ASC
      `;

      const result = await client.execute({ sql, args });
      const histories = {};

      for (const row of result.rows) {
        const siteId = String(readRowField(row, 'siteId', 0, ''));
        const listingId = String(readRowField(row, 'listing_id', 1, ''));
        const key = keyForHistory(siteId, listingId);
        if (!histories[key]) {
          histories[key] = [];
        }

        histories[key].push({
          runId: toNumber(readRowField(row, 'run_id', 2, 0), 0),
          priceNum: normalizePriceNumber(readRowField(row, 'price_num', 3, null), readRowField(row, 'price', 4, '')),
          price: String(readRowField(row, 'price', 4, '')),
          scrapedAt: String(readRowField(row, 'scrapedAt', 5, '')),
        });
      }

      res.json({ histories });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.use(express.static(publicDir));

  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, host, () => resolve(instance));
    instance.once('error', reject);
  });

  return {
    app,
    server,
    url: `http://localhost:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await client.close();
    },
  };
}

module.exports = {
  startDashboardServer,
};

const DEFAULT_MAX_MISS_COUNT = 3;

/** @typedef {import('./types').Listing} Listing */
/** @typedef {import('./types').NormalizedListing} NormalizedListing */
/** @typedef {import('./types').ListingFieldDiff} ListingFieldDiff */
/** @typedef {import('./types').DetectionResult} DetectionResult */

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {unknown} rawPrice
 * @returns {number | null}
 */
function normalizePriceNumber(rawPrice) {
  if (!rawPrice) {
    return null;
  }

  const source = String(rawPrice).trim();
  if (!source) {
    return null;
  }

  // Keep only numeric/separator characters and then normalize locale variants.
  const compact = source.replace(/\s+/g, '').replace(/[^\d,.-]/g, '');
  if (!compact) {
    return null;
  }

  let normalized = compact;
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
  } else if (hasDot && !/\.\d{1,2}$/.test(normalized)) {
    normalized = normalized.replace(/\./g, '');
  }

  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.round(value);
}

/**
 * @param {Listing} row
 * @returns {NormalizedListing}
 */
function normalizeListing(row) {
  return {
    id: String(row.id),
    siteId: String(row.siteId),
    title: String(row.title || ''),
    titleNorm: normalizeText(row.title),
    location: String(row.location || ''),
    locationNorm: normalizeText(row.location),
    price: String(row.price || ''),
    priceNum: normalizePriceNumber(row.price),
    detailUrl: String(row.detailUrl || ''),
    scrapedAt: String(row.scrapedAt || ''),
  };
}

/**
 * @param {string} field
 * @param {unknown} oldValue
 * @param {unknown} newValue
 * @returns {ListingFieldDiff}
 */
function buildDiff(field, oldValue, newValue) {
  return { field, old: oldValue, new: newValue };
}

/**
 * @param {Record<string, unknown>} previous
 * @param {NormalizedListing} current
 * @returns {{priceDiffs: ListingFieldDiff[], attributeDiffs: ListingFieldDiff[]}}
 */
function determineChanges(previous, current) {
  const priceDiffs = [];
  const attributeDiffs = [];

  if (previous.price_num !== current.priceNum) {
    priceDiffs.push(buildDiff('price_num', previous.price_num, current.priceNum));
    priceDiffs.push(buildDiff('price', previous.price, current.price));
  }

  if (previous.title_norm !== current.titleNorm) {
    attributeDiffs.push(buildDiff('title', previous.title, current.title));
  }
  if (previous.location_norm !== current.locationNorm) {
    attributeDiffs.push(buildDiff('location', previous.location, current.location));
  }
  if ((previous.detailUrl || '') !== current.detailUrl) {
    attributeDiffs.push(buildDiff('detailUrl', previous.detailUrl || '', current.detailUrl));
  }

  return {
    priceDiffs,
    attributeDiffs,
  };
}

/**
 * @param {Map<string, Record<string, unknown>>} previousMap
 * @param {NormalizedListing[]} normalizedListings
 * @param {number} maxMissCount
 * @param {string} nowIso
 * @returns {DetectionResult}
 */
function detectChanges(previousMap, normalizedListings, maxMissCount, nowIso) {
  const seenIds = new Set();
  const events = [];
  const upsertsCurrent = [];
  const missingUpdates = [];

  let newCount = 0;
  let priceChangedCount = 0;
  let attributesChangedCount = 0;
  let removedCount = 0;
  let reappearedCount = 0;

  for (const listing of normalizedListings) {
    seenIds.add(listing.id);
    const previous = previousMap.get(listing.id);

    if (!previous) {
      events.push({
        listingId: listing.id,
        changeType: 'new',
        diff: [buildDiff('state', null, 'new')],
      });
      newCount += 1;

      upsertsCurrent.push({
        ...listing,
        firstSeen: nowIso,
        lastSeen: nowIso,
        missCount: 0,
        isActive: 1,
        removedAt: null,
      });
      continue;
    }

    const { priceDiffs, attributeDiffs } = determineChanges(previous, listing);

    if (priceDiffs.length > 0) {
      events.push({
        listingId: listing.id,
        changeType: 'price_changed',
        diff: priceDiffs,
      });
      priceChangedCount += 1;
    }

    if (attributeDiffs.length > 0) {
      events.push({
        listingId: listing.id,
        changeType: 'attributes_changed',
        diff: attributeDiffs,
      });
      attributesChangedCount += 1;
    }

    if (Number(previous.is_active) === 0) {
      events.push({
        listingId: listing.id,
        changeType: 'new',
        diff: [buildDiff('state', 'removed', 'new')],
      });
      events.push({
        listingId: listing.id,
        changeType: 'reappeared',
        diff: [
          buildDiff('miss_count', Number(previous.miss_count), 0),
          buildDiff('is_active', false, true),
        ],
      });
      newCount += 1;
      reappearedCount += 1;
    }

    upsertsCurrent.push({
      ...listing,
      firstSeen: previous.first_seen,
      lastSeen: nowIso,
      missCount: 0,
      isActive: 1,
      removedAt: null,
    });
  }

  for (const [listingId, previous] of previousMap.entries()) {
    if (seenIds.has(listingId)) {
      continue;
    }

    const previousMiss = Number(previous.miss_count || 0);
    const nextMiss = previousMiss + 1;
    const currentlyActive = Number(previous.is_active) === 1;
    const shouldRemove = currentlyActive && nextMiss >= maxMissCount;
    const nextActive = shouldRemove ? 0 : Number(previous.is_active);

    if (shouldRemove) {
      events.push({
        listingId,
        changeType: 'removed',
        diff: [
          buildDiff('miss_count', previousMiss, nextMiss),
          buildDiff('is_active', true, false),
        ],
      });
      removedCount += 1;
    }

    missingUpdates.push({
      siteId: previous.siteId,
      listingId,
      missCount: nextMiss,
      isActive: nextActive,
      removedAt: shouldRemove && !previous.removed_at ? nowIso : previous.removed_at,
    });
  }

  return {
    events,
    upsertsCurrent,
    missingUpdates,
    summary: {
      listingsFound: normalizedListings.length,
      newCount,
      priceChangedCount,
      attributesChangedCount,
      removedCount,
      reappearedCount,
    },
  };
}

module.exports = {
  DEFAULT_MAX_MISS_COUNT,
  normalizeListing,
  detectChanges,
};

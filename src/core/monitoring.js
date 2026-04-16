const DEFAULT_MAX_MISS_COUNT = 3;
const MAX_REASONABLE_PRICE_NUM = 50000000;

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
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }

  return Math.round(num);
}

/**
 * @param {unknown} value
 * @returns {'sale'|'rent'|''}
 */
function normalizeTransactionType(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return '';
  }
  if (['sale', 'venta'].includes(normalized)) {
    return 'sale';
  }
  if (['rent', 'alquiler'].includes(normalized)) {
    return 'rent';
  }
  return '';
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

  const candidates = source.match(/\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d{4,}/g);
  if (!candidates || candidates.length === 0) {
    return null;
  }

  // If a string accidentally contains multiple amounts, prefer the last one.
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
  } else if (hasDot && !/\.\d{1,2}$/.test(normalized)) {
    normalized = normalized.replace(/\./g, '');
  }

  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) {
    return null;
  }

  const rounded = Math.round(value);
  if (rounded <= 0 || rounded > MAX_REASONABLE_PRICE_NUM) {
    return null;
  }

  return rounded;
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
    reference: String(row.reference || ''),
    description: String(row.description || ''),
    transactionType: normalizeTransactionType(row.transactionType),
    size: String(row.size || ''),
    bedrooms: normalizeInteger(row.bedrooms),
    bathrooms: normalizeInteger(row.bathrooms),
    garages: normalizeInteger(row.garages),
    imageUrl: String(row.imageUrl || ''),
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
 * @param {NormalizedListing} listing
 * @returns {{title: string, location: string, price: string, detailUrl: string}}
 */
function apartmentFromListing(listing) {
  return {
    title: listing.title,
    location: listing.location,
    price: listing.price,
    detailUrl: listing.detailUrl,
  };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {{title: string, location: string, price: string, detailUrl: string}}
 */
function apartmentFromCurrent(row) {
  return {
    title: String(row.title || ''),
    location: String(row.location || ''),
    price: String(row.price || ''),
    detailUrl: String(row.detailUrl || ''),
  };
}

/**
 * @param {NormalizedListing} listing
 * @param {'new'|'reappeared'} mode
 * @returns {ListingFieldDiff[]}
 */
function buildListingDetailsDiff(listing, mode) {
  const previousState = mode === 'reappeared' ? 'removed' : null;
  return [
    buildDiff('state', previousState, 'new'),
    buildDiff('title', null, listing.title),
    buildDiff('location', null, listing.location),
    buildDiff('price', null, listing.price),
    buildDiff('price_num', null, listing.priceNum),
    buildDiff('detailUrl', null, listing.detailUrl),
    buildDiff('reference', null, listing.reference),
    buildDiff('description', null, listing.description),
    buildDiff('transactionType', null, listing.transactionType),
    buildDiff('size', null, listing.size),
    buildDiff('bedrooms', null, listing.bedrooms),
    buildDiff('bathrooms', null, listing.bathrooms),
    buildDiff('garages', null, listing.garages),
    buildDiff('imageUrl', null, listing.imageUrl),
  ];
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
  if ((previous.reference || '') !== current.reference) {
    attributeDiffs.push(buildDiff('reference', previous.reference || '', current.reference));
  }
  if ((previous.description || '') !== current.description) {
    attributeDiffs.push(buildDiff('description', previous.description || '', current.description));
  }
  if ((previous.transactionType || '') !== current.transactionType) {
    attributeDiffs.push(buildDiff('transactionType', previous.transactionType || '', current.transactionType));
  }
  if ((previous.size || '') !== current.size) {
    attributeDiffs.push(buildDiff('size', previous.size || '', current.size));
  }

  const previousBedrooms = normalizeInteger(previous.bedrooms);
  if (previousBedrooms !== current.bedrooms) {
    attributeDiffs.push(buildDiff('bedrooms', previousBedrooms, current.bedrooms));
  }

  const previousBathrooms = normalizeInteger(previous.bathrooms);
  if (previousBathrooms !== current.bathrooms) {
    attributeDiffs.push(buildDiff('bathrooms', previousBathrooms, current.bathrooms));
  }

  const previousGarages = normalizeInteger(previous.garages);
  if (previousGarages !== current.garages) {
    attributeDiffs.push(buildDiff('garages', previousGarages, current.garages));
  }

  if ((previous.imageUrl || '') !== current.imageUrl) {
    attributeDiffs.push(buildDiff('imageUrl', previous.imageUrl || '', current.imageUrl));
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
        diff: buildListingDetailsDiff(listing, 'new'),
        apartment: apartmentFromListing(listing),
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
        apartment: apartmentFromListing(listing),
      });
      priceChangedCount += 1;
    }

    if (attributeDiffs.length > 0) {
      events.push({
        listingId: listing.id,
        changeType: 'attributes_changed',
        diff: attributeDiffs,
        apartment: apartmentFromListing(listing),
      });
      attributesChangedCount += 1;
    }

    if (Number(previous.is_active) === 0) {
      events.push({
        listingId: listing.id,
        changeType: 'new',
        diff: buildListingDetailsDiff(listing, 'reappeared'),
        apartment: apartmentFromListing(listing),
      });
      events.push({
        listingId: listing.id,
        changeType: 'reappeared',
        diff: [
          buildDiff('miss_count', Number(previous.miss_count), 0),
          buildDiff('is_active', false, true),
        ],
        apartment: apartmentFromListing(listing),
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
        apartment: apartmentFromCurrent(previous),
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

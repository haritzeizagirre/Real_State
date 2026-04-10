/**
 * Shared JSDoc typedefs for scraper, monitoring, and persistence modules.
 * This file is runtime-light and exists primarily for editor/type tooling.
 */

/**
 * @typedef {Object} Listing
 * @property {string} id Stable listing identifier.
 * @property {string} title
 * @property {string} price Raw price text from source site.
 * @property {string} location
 * @property {string} detailUrl
 * @property {string} scrapedAt ISO timestamp.
 * @property {string} siteId Adapter site identifier.
 */

/**
 * @typedef {Object} SiteAdapter
 * @property {string} siteId
 * @property {(params: Record<string, unknown>) => Promise<Listing[]>} list
 */

/**
 * @typedef {Object} NormalizedListing
 * @property {string} id
 * @property {string} siteId
 * @property {string} title
 * @property {string} titleNorm
 * @property {string} location
 * @property {string} locationNorm
 * @property {string} price
 * @property {number | null} priceNum
 * @property {string} detailUrl
 * @property {string} scrapedAt
 */

/**
 * @typedef {Object} ListingFieldDiff
 * @property {string} field
 * @property {unknown} old
 * @property {unknown} new
 */

/**
 * @typedef {'new'|'price_changed'|'attributes_changed'|'removed'|'reappeared'} ChangeType
 */

/**
 * @typedef {Object} ListingChangeEvent
 * @property {string} listingId
 * @property {ChangeType} changeType
 * @property {ListingFieldDiff[]} diff
 */

/**
 * @typedef {Object} DetectionSummary
 * @property {number} listingsFound
 * @property {number} newCount
 * @property {number} priceChangedCount
 * @property {number} attributesChangedCount
 * @property {number} removedCount
 * @property {number} reappearedCount
 */

/**
 * @typedef {Object} DetectionResult
 * @property {ListingChangeEvent[]} events
 * @property {Array<Record<string, unknown>>} upsertsCurrent
 * @property {Array<Record<string, unknown>>} missingUpdates
 * @property {DetectionSummary} summary
 */

/**
 * @typedef {Object} PersistRunParams
 * @property {string} siteId
 * @property {Listing[]} listings
 * @property {number} [maxMissCount]
 * @property {boolean} [dryRun]
 * @property {string} [startedAt]
 * @property {string} [finishedAt]
 * @property {boolean} [dualWriteLegacy]
 */

/**
 * @typedef {Object} PersistRunReport
 * @property {boolean} dryRun
 * @property {number | null} runId
 * @property {number} maxMissCount
 * @property {number} listingsFound
 * @property {number} newCount
 * @property {number} priceChangedCount
 * @property {number} attributesChangedCount
 * @property {number} removedCount
 * @property {number} reappearedCount
 * @property {number} totalChanges
 * @property {ListingChangeEvent[]} changes
 */

module.exports = {};

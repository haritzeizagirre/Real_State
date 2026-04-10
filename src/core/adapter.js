/** @typedef {import('./types').Listing} Listing */
/** @typedef {import('./types').SiteAdapter} SiteAdapter */

/**
 * Basic runtime contract validation for adapters.
 * @param {unknown} adapter
 */
function assertValidAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('Adapter must be an object.');
  }

  if (typeof adapter.siteId !== 'string' || !adapter.siteId.trim()) {
    throw new Error('Adapter siteId must be a non-empty string.');
  }

  if (typeof adapter.list !== 'function') {
    throw new Error(`Adapter "${adapter.siteId}" must implement list(params).`);
  }
}

module.exports = {
  assertValidAdapter,
};

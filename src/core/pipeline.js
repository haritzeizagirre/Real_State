const { assertValidAdapter } = require('./adapter');

/**
 * @param {Record<string, import('./types').SiteAdapter>} adapters
 */
function createPipeline(adapters) {
  for (const adapter of Object.values(adapters)) {
    assertValidAdapter(adapter);
  }

  return {
    listSites() {
      return Object.keys(adapters).sort();
    },

    /**
     * @param {string} siteId
     * @param {Record<string, unknown>} params
     */
    async scrape(siteId, params = {}) {
      const adapter = adapters[siteId];
      if (!adapter) {
        throw new Error(`Unknown site "${siteId}". Available sites: ${Object.keys(adapters).join(', ')}`);
      }

      const listings = await adapter.list(params);
      const byId = new Map();

      for (const listing of listings) {
        if (!listing || typeof listing.id !== 'string' || !listing.id.trim()) {
          throw new Error(`Adapter "${siteId}" returned listing without a non-empty id.`);
        }
        byId.set(listing.id, listing);
      }

      return Array.from(byId.values());
    },
  };
}

module.exports = {
  createPipeline,
};

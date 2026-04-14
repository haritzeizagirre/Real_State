const { iparraldeAdapter } = require('./iparralde');
const { mascasaAdapter } = require('./mascasa');
const { inmolaiakAdapter } = require('./inmolaiak');
const { inmocolonAdapter } = require('./inmocolon');
const { urmeAdapter } = require('./urme');
const { threeHiruHomeAdapter } = require('./3hiruhome');

const adapters = {
  [iparraldeAdapter.siteId]: iparraldeAdapter,
  [mascasaAdapter.siteId]: mascasaAdapter,
  [inmolaiakAdapter.siteId]: inmolaiakAdapter,
  [inmocolonAdapter.siteId]: inmocolonAdapter,
  [urmeAdapter.siteId]: urmeAdapter,
  [threeHiruHomeAdapter.siteId]: threeHiruHomeAdapter,
};

module.exports = {
  adapters,
};

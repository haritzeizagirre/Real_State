const { iparraldeAdapter } = require('./iparralde');
const { mascasaAdapter } = require('./mascasa');

const adapters = {
  [iparraldeAdapter.siteId]: iparraldeAdapter,
  [mascasaAdapter.siteId]: mascasaAdapter,
};

module.exports = {
  adapters,
};

const { PHRASES, E } = require('./phraseBank');
const { DEFAULT_SEASONAL_PACKAGES, SEASONAL_PACKAGE_LABELS, normalizeSeasonalPackages, isSeasonalPackageEnabled, enabledPackageIds } = require('./seasonal');
const { weekKey, availablePhrases, choosePhrase, pickRecentNickname, renderPhrase } = require('./phraseSelector');

module.exports = {
  PHRASES,
  E,
  DEFAULT_SEASONAL_PACKAGES,
  SEASONAL_PACKAGE_LABELS,
  normalizeSeasonalPackages,
  isSeasonalPackageEnabled,
  enabledPackageIds,
  weekKey,
  availablePhrases,
  choosePhrase,
  pickRecentNickname,
  renderPhrase,
};

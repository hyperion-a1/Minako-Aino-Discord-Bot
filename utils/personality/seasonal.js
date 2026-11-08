const DEFAULT_SEASONAL_PACKAGES = Object.freeze({
  halloween: true,
  natal: true,
  ano_novo: true,
});

const SEASONAL_PACKAGE_LABELS = Object.freeze({
  halloween: 'Halloween',
  natal: 'Natal',
  ano_novo: 'Ano Novo',
});

function normalizeSeasonalPackages(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.keys(DEFAULT_SEASONAL_PACKAGES).map(id => [id, source[id] !== false]));
}

function isSeasonalPackageEnabled(config, packageId) {
  if (!packageId) return true;
  return normalizeSeasonalPackages(config?.seasonalPackages)[packageId] !== false;
}

function enabledPackageIds(config) {
  return Object.keys(normalizeSeasonalPackages(config?.seasonalPackages)).filter(id => isSeasonalPackageEnabled(config, id));
}

module.exports = {
  DEFAULT_SEASONAL_PACKAGES,
  SEASONAL_PACKAGE_LABELS,
  normalizeSeasonalPackages,
  isSeasonalPackageEnabled,
  enabledPackageIds,
};

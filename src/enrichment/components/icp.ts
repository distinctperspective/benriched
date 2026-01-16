// ICP (Ideal Customer Profile) configuration and calculation

// Target NAICS codes for ICP matching
export const TARGET_ICP_NAICS = new Set([
  '111219', '111333', '111334', '111339', '111998', '112120', '112210', '112310', '112320', '112330', '112340', '112390',
  '115114', '311111', '311119', '311211', '311212', '311213', '311221', '311224', '311225', '311230', '311313', '311314',
  '311340', '311351', '311352', '311411', '311412', '311421', '311422', '311423', '311511', '311512', '311513', '311514',
  '311520', '311611', '311612', '311613', '311615', '311710', '311811', '311812', '311813', '311821', '311824', '311830',
  '311911', '311919', '311920', '311930', '311941', '311942', '311991', '311999', '312111', '312112', '312120', '312130',
  '312140', '424410', '424420', '424430', '424440', '424450', '424460', '424470', '424480', '424490', '424510', '424590',
  '445110', '445131', '493120'
]);

// Valid revenue bands
export const VALID_REVENUE_BANDS = new Set([
  '0-500K', '500K-1M', '1M-5M', '5M-10M', '10M-25M', '25M-75M',
  '75M-200M', '200M-500M', '500M-1B', '1B-10B', '10B-100B', '100B-1T'
]);

// Revenue bands that PASS (above $10M)
export const PASSING_REVENUE_BANDS = new Set([
  '10M-25M', '25M-75M', '75M-200M', '200M-500M', '500M-1B', '1B-10B', '10B-100B', '100B-1T'
]);

// Target regions for ICP (US, Mexico, Canada, Puerto Rico)
export const TARGET_REGIONS = new Set(['US', 'MX', 'CA', 'PR']);

// Check if a revenue band passes the threshold
export function isPassingRevenue(revenueBand: string | null): boolean {
  return revenueBand !== null && PASSING_REVENUE_BANDS.has(revenueBand);
}

// Check if NAICS codes match target ICP
export function hasMatchingNaics(naicsCodes: Array<{ code: string }>): boolean {
  return naicsCodes.some(naics => TARGET_ICP_NAICS.has(naics.code));
}

// Get matching NAICS codes
export function getMatchingNaics<T extends { code: string }>(naicsCodes: T[]): T[] {
  return naicsCodes.filter(naics => TARGET_ICP_NAICS.has(naics.code));
}

// Check if company is in target region
export function isInTargetRegion(hqCountry: string | null, isUsHq: boolean, isUsSubsidiary: boolean): boolean {
  return (hqCountry !== null && TARGET_REGIONS.has(hqCountry)) || isUsHq || isUsSubsidiary;
}

// Calculate full ICP status
export function calculateTargetIcp(
  naicsCodes: Array<{ code: string }>,
  hqCountry: string | null,
  isUsHq: boolean,
  isUsSubsidiary: boolean,
  revenueBand: string | null
): boolean {
  const hasIndustry = hasMatchingNaics(naicsCodes);
  const hasRegion = isInTargetRegion(hqCountry, isUsHq, isUsSubsidiary);
  const hasRevenue = isPassingRevenue(revenueBand);
  
  return hasIndustry && hasRegion && hasRevenue;
}

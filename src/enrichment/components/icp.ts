// ICP (Ideal Customer Profile) configuration and calculation
import { createClient } from '@supabase/supabase-js';

// Target NAICS codes for ICP matching - loaded from database
export let TARGET_ICP_NAICS = new Set<string>();
let isNaicsLoaded = false;

// Load target ICP NAICS codes from database
async function loadTargetNaicsCodes(): Promise<void> {
  if (isNaicsLoaded) return;
  
  const supabase = createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_ANON_KEY || ''
  );
  
  const { data, error } = await supabase
    .from('naics_codes')
    .select('naics_code')
    .eq('target_icp', true);
  
  if (error) {
    console.error('Error loading target ICP NAICS codes:', error);
    // Fallback to empty set if database fails
    TARGET_ICP_NAICS = new Set();
  } else if (data) {
    TARGET_ICP_NAICS = new Set(data.map(n => n.naics_code));
    console.log(`✅ Loaded ${TARGET_ICP_NAICS.size} target ICP NAICS codes from database`);
  }
  
  isNaicsLoaded = true;
}

// Initialize NAICS codes on module load
loadTargetNaicsCodes().catch(console.error);

// Valid revenue bands
export const VALID_REVENUE_BANDS = new Set([
  '0-500K', '500K-1M', '1M-5M', '5M-10M', '10M-25M', '25M-75M',
  '75M-200M', '200M-500M', '500M-1B', '1B-10B', '10B-100B', '100B-1T'
]);

// Valid size bands
export const VALID_SIZE_BANDS = [
  '0-1 Employees', '2-10 Employees', '11-50 Employees', '51-200 Employees',
  '201-500 Employees', '501-1,000 Employees', '1,001-5,000 Employees',
  '5,001-10,000 Employees', '10,001+ Employees'
];

// Normalize size band to valid values
export function normalizeSizeBand(size: string | null | undefined): string {
  if (!size || size === 'unknown') return 'unknown';
  
  // Already valid
  if (VALID_SIZE_BANDS.includes(size)) return size;
  
  // Extract number from size string
  const numMatch = size.match(/(\d[\d,]*)/);
  if (!numMatch) return 'unknown';
  
  const count = parseInt(numMatch[1].replace(/,/g, ''), 10);
  
  // Map to valid band
  if (count <= 1) return '0-1 Employees';
  if (count <= 10) return '2-10 Employees';
  if (count <= 50) return '11-50 Employees';
  if (count <= 200) return '51-200 Employees';
  if (count <= 500) return '201-500 Employees';
  if (count <= 1000) return '501-1,000 Employees';
  if (count <= 5000) return '1,001-5,000 Employees';
  if (count <= 10000) return '5,001-10,000 Employees';
  return '10,001+ Employees';
}

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
export async function hasMatchingNaics(naicsCodes: Array<{ code: string }>): Promise<boolean> {
  await loadTargetNaicsCodes();
  return naicsCodes.some(naics => TARGET_ICP_NAICS.has(naics.code));
}

// Get matching NAICS codes
export async function getMatchingNaics<T extends { code: string }>(naicsCodes: T[]): Promise<T[]> {
  await loadTargetNaicsCodes();
  return naicsCodes.filter(naics => TARGET_ICP_NAICS.has(naics.code));
}

// Check if company is in target region
export function isInTargetRegion(hqCountry: string | null, isUsHq: boolean, isUsSubsidiary: boolean): boolean {
  return (hqCountry !== null && TARGET_REGIONS.has(hqCountry)) || isUsHq || isUsSubsidiary;
}

// Calculate full ICP status
export async function calculateTargetIcp(
  naicsCodes: Array<{ code: string }>,
  hqCountry: string | null,
  isUsHq: boolean,
  isUsSubsidiary: boolean,
  revenueBand: string | null
): Promise<boolean> {
  const hasIndustry = await hasMatchingNaics(naicsCodes);
  const hasRegion = isInTargetRegion(hqCountry, isUsHq, isUsSubsidiary);
  const hasRevenue = isPassingRevenue(revenueBand);
  
  return hasIndustry && hasRegion && hasRevenue;
}

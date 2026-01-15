export function parseRevenueAmountToUsd(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const match = cleaned.match(/([-+]?\d*\.?\d+)/);
  if (!match) return null;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;

  let multiplier = 1;
  if (/(billion|\bbn\b)/.test(cleaned)) multiplier = 1_000_000_000;
  else if (/(million|\bm\b)/.test(cleaned)) multiplier = 1_000_000;
  else if (/(thousand|\bk\b)/.test(cleaned)) multiplier = 1_000;

  const value = base * multiplier;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function mapUsdToRevenueBand(usd: number): string | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const bands: Array<{ min: number; max: number; label: string }> = [
    { min: 0, max: 500_000, label: '0-500K' },
    { min: 500_000, max: 1_000_000, label: '500K-1M' },
    { min: 1_000_000, max: 5_000_000, label: '1M-5M' },
    { min: 5_000_000, max: 10_000_000, label: '5M-10M' },
    { min: 10_000_000, max: 25_000_000, label: '10M-25M' },
    { min: 25_000_000, max: 75_000_000, label: '25M-75M' },
    { min: 75_000_000, max: 200_000_000, label: '75M-200M' },
    { min: 200_000_000, max: 500_000_000, label: '200M-500M' },
    { min: 500_000_000, max: 1_000_000_000, label: '500M-1B' },
    { min: 1_000_000_000, max: 10_000_000_000, label: '1B-10B' },
    { min: 10_000_000_000, max: 100_000_000_000, label: '10B-100B' },
    { min: 100_000_000_000, max: 1_000_000_000_000, label: '100B-1T' },
  ];

  const band = bands.find((b) => usd >= b.min && usd < b.max);
  return band?.label || (usd >= 1_000_000_000_000 ? '100B-1T' : null);
}

export function parseEmployeeBandLowerBound(companySize: string): number | null {
  if (!companySize) return null;
  const cleaned = companySize.replace(/employees/i, '').trim();
  const range = cleaned.match(/(\d[\d,]*)\s*[-–]\s*(\d[\d,]*)/);
  if (range) return Number(range[1].replace(/,/g, ''));
  const plus = cleaned.match(/(\d[\d,]*)\s*\+/);
  if (plus) return Number(plus[1].replace(/,/g, ''));
  const single = cleaned.match(/^(\d[\d,]*)$/);
  if (single) return Number(single[1].replace(/,/g, ''));
  return null;
}

export function countryNameToCode(countryName: string): string {
  if (!countryName) return 'unknown';
  const name = countryName.trim().toLowerCase();

  const countryMap: Record<string, string> = {
    'united states': 'US',
    'usa': 'US',
    'us': 'US',
    'canada': 'CA',
    'ca': 'CA',
    'mexico': 'MX',
    'united kingdom': 'GB',
    'uk': 'GB',
    'germany': 'DE',
    'france': 'FR',
    'italy': 'IT',
    'spain': 'ES',
    'netherlands': 'NL',
    'belgium': 'BE',
    'switzerland': 'CH',
    'sweden': 'SE',
    'norway': 'NO',
    'denmark': 'DK',
    'finland': 'FI',
    'poland': 'PL',
    'czech republic': 'CZ',
    'austria': 'AT',
    'ireland': 'IE',
    'portugal': 'PT',
    'greece': 'GR',
    'japan': 'JP',
    'china': 'CN',
    'india': 'IN',
    'australia': 'AU',
    'new zealand': 'NZ',
    'singapore': 'SG',
    'hong kong': 'HK',
    'south korea': 'KR',
    'thailand': 'TH',
    'vietnam': 'VN',
    'brazil': 'BR',
    'argentina': 'AR',
    'chile': 'CL',
    'colombia': 'CO',
    'peru': 'PE',
    'south africa': 'ZA',
    'israel': 'IL',
    'uae': 'AE',
    'united arab emirates': 'AE',
    'saudi arabia': 'SA',
    'turkey': 'TR',
    'russia': 'RU',
  };

  return countryMap[name] || 'unknown';
}

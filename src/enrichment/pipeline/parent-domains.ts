// ============================================================================
// PARENT COMPANY DOMAIN GUESSING
// Known mappings from parent company names to their domains
// ============================================================================

export const KNOWN_PARENT_DOMAINS: Record<string, string> = {
  'general mills': 'generalmills.com',
  'lactalis': 'lactalis.com',
  'lactalis usa': 'lactalisusa.com',
  'nestle': 'nestle.com',
  'kraft heinz': 'kraftheinzcompany.com',
  'pepsico': 'pepsico.com',
  'coca-cola': 'coca-colacompany.com',
  'the coca-cola company': 'coca-colacompany.com',
  'unilever': 'unilever.com',
  'mondelez': 'mondelezinternational.com',
  'tyson foods': 'tyson.com',
  'jbs': 'jbs.com.br',
  'cargill': 'cargill.com',
  'archer daniels midland': 'adm.com',
  'adm': 'adm.com',
  'conagra': 'conagrabrands.com',
  'conagra brands': 'conagrabrands.com',
  'hormel': 'hormelfoods.com',
  'hormel foods': 'hormelfoods.com',
  'smithfield': 'smithfieldfoods.com',
  'smithfield foods': 'smithfieldfoods.com',
  'premium brands': 'premiumbrandsholdings.com',
  'premium brands holdings': 'premiumbrandsholdings.com',
  'premium brands holdings corporation': 'premiumbrandsholdings.com',
  'maple leaf foods': 'mapleleaffoods.com',
  'saputo': 'saputo.com',
  'danone': 'danone.com',
  'kellogg': 'kelloggcompany.com',
  "kellogg's": 'kelloggcompany.com',
  'post holdings': 'postholdings.com',
  'treehouse foods': 'treehousefoods.com',
  'b&g foods': 'bgfoods.com',
  'campbell soup': 'campbellsoupcompany.com',
  'campbell soup company': 'campbellsoupcompany.com',
  'the campbells company': 'campbellsoupcompany.com',
  "campbell's": 'campbellsoupcompany.com',
  'smucker': 'jmsmucker.com',
  'j.m. smucker': 'jmsmucker.com',
  'the j.m. smucker company': 'jmsmucker.com',
  'hershey': 'thehersheycompany.com',
  'the hershey company': 'thehersheycompany.com',
  'mars': 'mars.com',
  'ferrero': 'ferrero.com',
  'lindt': 'lindt-spruengli.com',
  'blue diamond growers': 'bluediamond.com',
  'ocean spray': 'oceanspray.com',
  'land o lakes': 'landolakesinc.com',
  "land o'lakes": 'landolakesinc.com',
  'dairy farmers of america': 'dfamilk.com',
  'dean foods': 'deanfoods.com',
  'schreiber foods': 'schreiberfoods.com',
  'leprino foods': 'leprinofoods.com',
  'tillamook': 'tillamook.com',
  'celerian group': 'celeriangroup.com',
};

export function guessParentDomain(parentName: string): string | null {
  if (!parentName) return null;

  const normalized = parentName.toLowerCase().trim();

  // Check known mappings first
  if (KNOWN_PARENT_DOMAINS[normalized]) {
    return KNOWN_PARENT_DOMAINS[normalized];
  }

  // Try partial matches
  for (const [key, domain] of Object.entries(KNOWN_PARENT_DOMAINS)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return domain;
    }
  }

  // Generate a guess from the company name
  const cleaned = normalized
    .replace(/\s*(inc\.?|llc|ltd\.?|corp\.?|corporation|company|co\.?|holdings?|group|enterprises?)\s*$/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '');

  if (cleaned.length >= 3) {
    return `${cleaned}.com`;
  }

  return null;
}

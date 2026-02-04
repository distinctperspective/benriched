import { supabase } from './supabase.js';
import { getZoomInfoToken, clearTokenCache } from './zoominfo-auth.js';
import { enrichContactWithZoomInfo, ContactRecord } from './contact-enrich.js';
import { classifyTier } from './tier.js';
import { loadExclusionKeywords, checkExclusion } from './icp-exclusions.js';

const DEFAULT_MANAGEMENT_LEVELS = ['C Level Exec', 'VP Level Exec', 'Director', 'Manager'];
const DEFAULT_MAX_RESULTS = 25;
const MAX_RESULTS_LIMIT = 100;

// ICP-relevant keywords extracted from titles table for pre-search filtering
const ICP_JOB_TITLE_KEYWORDS = [
  'Quality', 'Operations', 'Food Safety', 'Safety', 'IT',
  'Production', 'EHS', 'Compliance', 'Supply Chain', 'Plant',
  'Regulatory', 'Manufacturing', 'Automation', 'Maintenance',
  'Continuous Improvement', 'FSQA', 'Digital Transformation',
];

// Executive titles to include for small companies (under 200 employees)
const EXECUTIVE_TITLE_KEYWORDS = [
  'Chief', 'CEO', 'CFO', 'COO', 'CIO', 'CTO',
  'President', 'Owner', 'Founder', 'Partner',
  'General Manager', 'Executive',
];

// Company size bands considered "small" - executives are key contacts
const SMALL_COMPANY_SIZES = [
  '0-1 Employees', '2-10 Employees', '11-50 Employees', '51-200 Employees',
];

// Abbreviation  full form map for title expansion before tier matching
const TITLE_ABBREVIATIONS: Record<string, string> = {
  'CEO': 'Chief Executive Officer',
  'CFO': 'Chief Financial Officer',
  'COO': 'Chief Operating Officer',
  'CIO': 'Chief Information Officer',
  'CTO': 'Chief Technology Officer',
  'CDO': 'Chief Digital Officer',
  'CPO': 'Chief Product Officer',
  'CMO': 'Chief Marketing Officer',
  'CHRO': 'Chief Human Resources Officer',
  'CQO': 'Chief Quality Officer',
  'SVP': 'Senior Vice President',
  'EVP': 'Executive Vice President',
  'AVP': 'Assistant Vice President',
  'VP': 'Vice President',
  'QA': 'Quality Assurance',
  'QC': 'Quality Control',
  'EHS': 'Environment Health Safety',
  'FSQA': 'Food Safety Quality Assurance',
  'IT': 'Information Technology',
  'R&D': 'Research and Development',
};

/** Expand known abbreviations in a job title (word-boundary aware) */
function expandAbbreviations(title: string): string {
  let expanded = title;
  for (const [abbr, full] of Object.entries(TITLE_ABBREVIATIONS)) {
    // Word-boundary aware replacement (case-insensitive)
    const regex = new RegExp("\\b" + (abbr.replace('&', '\\&')) + "\\b", 'gi');
    expanded = expanded.replace(regex, full);
  }
  return expanded;
}

export interface ContactSearchRequest {
  company_domain?: string;
  company_name?: string;
  management_levels?: string[];
  job_titles?: string[];
  max_results?: number;
  page?: number;
  enrich_contacts?: boolean;
  skip_cached?: boolean;
  hs_company_id?: string;
  use_icp_filter?: boolean;
  check_hubspot?: boolean; // default true - check HubSpot before enriching
  auto_paginate?: boolean; // default false - fetch all pages automatically
  require_contact_data?: boolean; // default true - filter out contacts with no email/phone
  filter_non_icp?: boolean; // default false - if true, remove non-ICP contacts from results
}

export interface ContactSearchResult {
  data: {
    company: {
      id?: string;
      domain?: string;
      company_name?: string;
      zoominfo_company_id?: string;
      hs_company_id?: string;
    };
    contacts: ContactRecord[];
    pagination: {
      page: number;
      page_size: number;
      total_results: number;
      total_pages: number;
      has_more: boolean;
    };
  };
  metadata: {
    search_filters: {
      management_levels: string[];
      job_titles?: string[];
      icp_keyword_filter?: boolean;
    };
    found_count: number;
    enriched_count?: number;
    cached_count?: number;
    tier_tagged_count?: number;
    ai_classified_count?: number;
    hubspot_checked_count?: number;
    hubspot_matched_count?: number;
    enrichment_skipped_count?: number;
    non_icp_count?: number;
    failed_count: number;
  };
  cost: {
    search_credits: number;
    enrich_credits: number;
    total_credits: number;
  };
  errors: Array<{ contact: string; reason: string }>;
  raw_search_response?: any;
  raw_enrich_responses?: any[];
}

interface ZoomInfoSearchContact {
  id: number;
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
  companyName?: string;
  companyId?: number;
  contactAccuracyScore?: number;
  validDate?: string;
  lastUpdatedDate?: string;
  hasEmail?: boolean;
  hasSupplementalEmail?: boolean;
  hasDirectPhone?: boolean;
  hasMobilePhone?: boolean;
}

interface TitleMatch {
  tier: string;
  tier_rank: number; // 4=Ultimate, 3=Strong Owner, 2=Manager, 1=IC, 0=Unknown
  matched_title: string | null;
  primary_persona: string | null; // Persona ID from lookup table
}

/**
 * Compare company match using ZoomInfo ID first, then fall back to name matching.
 *
 * @param ziCompanyId - ZoomInfo company ID from search results
 * @param hsCompanyZoomInfoId - ZoomInfo company ID stored in HubSpot company
 * @param ziName - Company name from ZoomInfo
 * @param hsName - Company name from HubSpot
 * @returns true if companies match
 */
function compareCompanyMatch(
  ziCompanyId: string | undefined,
  hsCompanyZoomInfoId: string | undefined,
  ziName: string | undefined,
  hsName: string | undefined
): boolean {
  // Primary match: Compare ZoomInfo company IDs (most reliable)
  if (ziCompanyId && hsCompanyZoomInfoId && ziCompanyId === hsCompanyZoomInfoId) {
    return true;
  }

  // Fallback: Fuzzy name matching
  if (!ziName || !hsName) return false;

  // Normalize names (lowercase, remove Inc/LLC/etc, trim whitespace)
  const normalize = (name: string) =>
    name.toLowerCase()
      .replace(/\b(inc|llc|ltd|corp|corporation|company|co|incorporated)\b\.?/g, '')
      .replace(/[,\.]/g, '') // Remove commas and periods
      .trim();

  const n1 = normalize(ziName);
  const n2 = normalize(hsName);

  // Exact match or one contains the other (e.g., "Acme" matches "Acme Corporation")
  return n1 === n2 || n1.includes(n2) || n2.includes(n1);
}

/**
 * Load titles from DB and match a job title against them.
 * Returns tier info. Uses normalized lowercase comparison.
 */
async function matchTitleToTier(jobTitle: string): Promise<TitleMatch> {
  const normalized = jobTitle.toLowerCase().trim();

  const { data: titles } = await supabase
    .from('titles')
    .select('title, tier, primary_persona');

  if (!titles || titles.length === 0) {
    return { tier: 'Tier 0 (Unknown)', tier_rank: 0, matched_title: null, primary_persona: null };
  }

  // Exact match first
  const exact = titles.find((t: any) => t.title.toLowerCase().trim() === normalized);
  if (exact) {
    return { tier: exact.tier, tier_rank: tierToRank(exact.tier), matched_title: exact.title, primary_persona: exact.primary_persona };
  }

  // Fuzzy: check if any DB title is contained in the job title or vice versa
  let bestMatch: { title: string; tier: string; primary_persona: string | null; score: number } | null = null;
  for (const t of titles) {
    const dbTitle = t.title.toLowerCase().trim();
    if (normalized.includes(dbTitle) || dbTitle.includes(normalized)) {
      const score = Math.min(dbTitle.length, normalized.length) / Math.max(dbTitle.length, normalized.length);
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { title: t.title, tier: t.tier, primary_persona: t.primary_persona, score };
      }
    }
  }

  if (bestMatch) {
    return { tier: bestMatch.tier, tier_rank: tierToRank(bestMatch.tier), matched_title: bestMatch.title, primary_persona: bestMatch.primary_persona };
  }

  return { tier: 'Tier 0 (Unknown)', tier_rank: 0, matched_title: null, primary_persona: null };
}

interface HubSpotMatch {
  firstName: string;
  lastName: string;
  hs_contact_id: string;
  company?: string;
  email?: string;
  jobtitle?: string;
  company_zoominfo_id?: string;
}

/**
 * Check HubSpot for existing contacts by firstname + lastname + company.
 * Batches up to 5 contacts per API call (HubSpot max 5 filterGroups).
 */
async function hubspotPreCheck(
  contacts: ZoomInfoSearchContact[],
  companyName: string,
  zoomInfoCompanyId: string | undefined,
  hubspotToken: string
): Promise<Map<string, HubSpotMatch>> {
  const matchMap = new Map<string, HubSpotMatch>(); // key: "firstname|lastname" lowercase

  if (!contacts.length || !hubspotToken) return matchMap;

  // Batch into groups of 5 (HubSpot max filterGroups)
  const batches: ZoomInfoSearchContact[][] = [];
  for (let i = 0; i < contacts.length; i += 5) {
    batches.push(contacts.slice(i, i + 5));
  }

  console.log("    HubSpot pre-check: " + (contacts.length) + " contacts in " + (batches.length) + " batch(es)...");

  for (const batch of batches) {
    const filterGroups = batch
      .filter((c) => c.firstName && c.lastName)
      .map((c) => ({
        filters: [
          { propertyName: 'firstname', operator: 'EQ', value: c.firstName! },
          { propertyName: 'lastname', operator: 'EQ', value: c.lastName! },
        ],
      }));

    if (!filterGroups.length) continue;

    try {
      const response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
        method: 'POST',
        headers: {
          'Authorization': "Bearer " + (hubspotToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filterGroups,
          properties: ['firstname', 'lastname', 'email', 'company', 'jobtitle'],
          limit: 100,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.log("    HubSpot search error: " + (response.status) + " - " + (errText));
        continue;
      }

      const data = await response.json();
      const results = data.results || [];

      // Get company associations using batch API
      const contactIds = results.map((r: any) => r.id);
      const contactCompanyMap = new Map<string, string>(); // contact_id -> company_id

      if (contactIds.length > 0) {
        try {
          // Batch associations API: get all contact->company associations in one call
          const assocResponse = await fetch('https://api.hubapi.com/crm/v4/associations/contacts/companies/batch/read', {
            method: 'POST',
            headers: {
              'Authorization': "Bearer " + hubspotToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              inputs: contactIds.map((id: string) => ({ id })),
            }),
          });

          if (assocResponse.ok) {
            const assocData = await assocResponse.json();
            for (const result of assocData.results || []) {
              if (result.from?.id && result.to?.[0]?.toObjectId) {
                contactCompanyMap.set(result.from.id, String(result.to[0].toObjectId));
              }
            }
          }
        } catch (err) {
          // Silent fail
        }
      }

      // Extract unique company IDs
      const companyIds: string[] = Array.from(new Set(contactCompanyMap.values()));

      // Fetch company ZoomInfo IDs in batch
      const companyZoomInfoIds = new Map<string, string>(); // hs_company_id -> zoominfo_company_id
      if (companyIds.length > 0 && hubspotToken) {
        try {
          const companyResponse = await fetch('https://api.hubapi.com/crm/v3/objects/companies/batch/read', {
            method: 'POST',
            headers: {
              'Authorization': "Bearer " + hubspotToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              inputs: companyIds.map(id => ({ id })),
              properties: ['zoominfo_company_id'],
            }),
          });

          if (companyResponse.ok) {
            const companyData = await companyResponse.json();
            for (const company of companyData.results || []) {
              const ziId = company.properties?.zoominfo_company_id;
              if (ziId) {
                companyZoomInfoIds.set(company.id, ziId);
              }
            }
          }
        } catch (err) {
          console.log("    HubSpot company batch read error: " + (err instanceof Error ? err.message : err));
        }
      }

      for (const hs of results) {
        const fn = (hs.properties?.firstname || '').toLowerCase().trim();
        const ln = (hs.properties?.lastname || '').toLowerCase().trim();
        if (fn && ln) {
          // Get ZoomInfo company ID from associated company
          const hsCompanyId = contactCompanyMap.get(hs.id);
          const companyZoomInfoId = hsCompanyId ? companyZoomInfoIds.get(hsCompanyId) : undefined;

          matchMap.set((fn) + "|" + (ln), {
            firstName: hs.properties.firstname,
            lastName: hs.properties.lastname,
            hs_contact_id: hs.id,
            company: hs.properties.company,
            email: hs.properties.email,
            jobtitle: hs.properties.jobtitle,
            company_zoominfo_id: companyZoomInfoId,
          });
        }
      }
    } catch (err) {
      console.log("    HubSpot pre-check batch error: " + (err instanceof Error ? err.message : err));
    }
  }

  console.log("    HubSpot matches: " + (matchMap.size) + "/" + (contacts.length));
  return matchMap;
}

function tierToRank(tier: string): number {
  if (tier.includes('Tier 4')) return 4;
  if (tier.includes('Tier 3')) return 3;
  if (tier.includes('Tier 2')) return 2;
  if (tier.includes('Tier 1')) return 1;
  return 0;
}

/** Check if contact has any reachable contact data (email or phone) */
function hasAnyContactData(c: ZoomInfoSearchContact): boolean {
  return c.hasEmail === true ||
         c.hasSupplementalEmail === true ||
         c.hasDirectPhone === true ||
         c.hasMobilePhone === true;
}

/** Load all titles from DB once for batch matching */
async function loadTitlesCache(): Promise<Array<{ title: string; tier: string; primary_persona: string | null }>> {
  const { data } = await supabase.from('titles').select('title, tier, primary_persona');
  return data || [];
}

function matchTitleFromCache(
  jobTitle: string,
  titles: Array<{ title: string; tier: string; primary_persona: string | null }>
): TitleMatch {
  const normalized = jobTitle.toLowerCase().trim();

  // Try exact match first
  const exact = titles.find((t) => t.title.toLowerCase().trim() === normalized);
  if (exact) {
    return { tier: exact.tier, tier_rank: tierToRank(exact.tier), matched_title: exact.title, primary_persona: exact.primary_persona };
  }

  // Try with abbreviations expanded (e.g., "CFO"  "Chief Financial Officer")
  const expanded = expandAbbreviations(jobTitle).toLowerCase().trim();
  if (expanded !== normalized) {
    const expandedExact = titles.find((t) => t.title.toLowerCase().trim() === expanded);
    if (expandedExact) {
      return { tier: expandedExact.tier, tier_rank: tierToRank(expandedExact.tier), matched_title: expandedExact.title, primary_persona: expandedExact.primary_persona };
    }
  }

  // Fuzzy containment match on both original and expanded
  let bestMatch: { title: string; tier: string; primary_persona: string | null; score: number } | null = null;
  for (const t of titles) {
    const dbTitle = t.title.toLowerCase().trim();
    for (const candidate of [normalized, expanded]) {
      if (candidate.includes(dbTitle) || dbTitle.includes(candidate)) {
        const score = Math.min(dbTitle.length, candidate.length) / Math.max(dbTitle.length, candidate.length);
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { title: t.title, tier: t.tier, primary_persona: t.primary_persona, score };
        }
      }
    }
  }

  if (bestMatch) {
    return { tier: bestMatch.tier, tier_rank: tierToRank(bestMatch.tier), matched_title: bestMatch.title, primary_persona: bestMatch.primary_persona };
  }

  return { tier: 'Tier 0 (Unknown)', tier_rank: 0, matched_title: null, primary_persona: null };
}

// Persona IDs for keyword-based inference
const PERSONA_IDS = {
  QUALITY_EHS: '7000a515-0f02-4102-a861-537b37acc07f',
  IT: 'a888e1b1-0931-4bd8-b1fb-1a2a337d7131',
  PRODUCTION: '58534e21-93e6-4311-8fce-2a64ee2cccd9',
  SUPPLY_CHAIN: 'c2c310e5-81a7-4364-851c-73feb33cda15',
  ENGINEERING: '1ad3e8d4-d751-4f64-b914-c7a5adfc4fe3',
  PLANT_LEADERSHIP: '6cfd7992-3776-4b1a-9777-da71a9abc50a',
  MAINTENANCE: 'abf1e505-4922-4575-93a8-85c07ab645d3',
  CORPORATE: 'c0d8459d-9259-48b0-b4dd-ab2da8db76a6',
};

// Persona ID to frontend label mapping
const PERSONA_LABELS: Record<string, string> = {
  [PERSONA_IDS.QUALITY_EHS]: "Champion",              // Quality/Safety → Champion
  [PERSONA_IDS.IT]: "Technical Evaluator",            // IT → Technical Evaluator
  [PERSONA_IDS.PRODUCTION]: "Site Lead",              // Production → Site Lead
  [PERSONA_IDS.SUPPLY_CHAIN]: "Champion",             // Supply Chain → Champion
  [PERSONA_IDS.ENGINEERING]: "Technical Evaluator",   // Engineering → Technical Evaluator
  [PERSONA_IDS.PLANT_LEADERSHIP]: "Executive Sponsor", // Plant Leadership → Executive Sponsor
  [PERSONA_IDS.MAINTENANCE]: "Champion",              // Maintenance → Champion
  [PERSONA_IDS.CORPORATE]: "Economic Buyer",          // Corporate → Economic Buyer
};

// Default personas by tier for unknown titles
const TIER_DEFAULT_PERSONAS: Record<string, string> = {
  "Tier 4 (Ultimate)": "Economic Buyer",       // C-suite, Presidents
  "Tier 3 (Strong Owner)": "Executive Sponsor", // VPs, Directors
  "Tier 2 (Manager / Recommender)": "Champion", // Managers
  "Tier 1 (Individual Contributor)": "Technical Evaluator",
  "Tier 0 (Unknown)": "Technical Evaluator",
};

/**
 * Determine engagement status based on HubSpot presence and ICP classification
 */
function determineContactStatus(
  in_hubspot: boolean,
  is_icp: boolean,
  hubspot_lifecycle_stage?: string
): string {
  // Already engaged in HubSpot
  if (in_hubspot) {
    if (hubspot_lifecycle_stage === "customer") return "ENGAGED";
    if (hubspot_lifecycle_stage === "opportunity") return "LATE STAGE";
    if (hubspot_lifecycle_stage === "lead" || hubspot_lifecycle_stage === "marketingqualifiedlead") {
      return "LATE STAGE";
    }
    return "LATE STAGE";
  }

  // Not in HubSpot - check ICP status
  if (!is_icp) {
    return "EXCLUDED";
  }

  // New ICP contact
  return "TARGET";
}

/**
 * Generate reasoning for why this contact is important
 */
function generateContactReasoning(
  job_title: string,
  icp_tier: string,
  persona_label: string,
  is_icp: boolean,
  icp_exclusion_reason: string | null,
  match_confidence?: string
): string {
  // Non-ICP contacts
  if (!is_icp && icp_exclusion_reason) {
    return `Excluded from ICP due to title keyword: "${icp_exclusion_reason}"`;
  }

  const tier_reasoning: Record<string, string> = {
    "Tier 4 (Ultimate)": "Executive-level decision maker with budget authority",
    "Tier 3 (Strong Owner)": "Senior leader who can champion initiatives internally",
    "Tier 2 (Manager / Recommender)": "Operational manager who influences purchasing decisions",
    "Tier 1 (Individual Contributor)": "Hands-on practitioner who can validate technical fit",
    "Tier 0 (Unknown)": "Potential stakeholder based on job title",
  };

  const base_reasoning = tier_reasoning[icp_tier] || "Stakeholder in the decision-making process";

  if (match_confidence === "high") {
    return `${base_reasoning}. High-confidence title match indicates strong ICP alignment.`;
  } else if (match_confidence === "medium") {
    return `${base_reasoning}. Moderate title match suggests potential influence.`;
  }

  return `${base_reasoning}. Role as ${persona_label} indicates involvement in evaluation or approval.`;
}

/**
 * Generate engagement strategy based on persona and tier
 */
function generateEngagementStrategy(
  persona_label: string,
  icp_tier: string,
  in_hubspot: boolean,
  has_email: boolean,
  has_direct_phone: boolean
): string {
  const persona_strategies: Record<string, string> = {
    "Economic Buyer": "ROI-focused pitch highlighting cost savings and operational efficiency gains. Schedule executive briefing.",
    "Executive Sponsor": "Strategic value discussion emphasizing competitive advantage and risk mitigation. Seek internal champion introduction.",
    "Financial Buyer": "Business case presentation with detailed ROI calculations and payback period analysis.",
    "Champion": "Product demo showcasing specific pain point solutions. Build relationship through regular check-ins.",
    "Site Lead": "Facility-level value prop focusing on day-to-day operational improvements. Offer site visit or pilot program.",
    "Technical Evaluator": "Technical deep-dive on integrations, security, and implementation. Provide detailed documentation and sandbox access.",
  };

  let strategy = persona_strategies[persona_label] || "Consultative approach to understand needs and priorities.";

  if (in_hubspot) {
    strategy += " Already in CRM - leverage existing relationship and previous interactions.";
  } else if (has_email && has_direct_phone) {
    strategy += " Multi-channel outreach: email introduction followed by phone call.";
  } else if (has_email) {
    strategy += " Email outreach with personalized value proposition.";
  } else if (has_direct_phone) {
    strategy += " Direct phone outreach - voicemail with follow-up email.";
  } else {
    strategy += " LinkedIn connection request with personalized message.";
  }

  return strategy;
}

/**
 * Assign priority level based on tier and ICP status
 */
function assignContactPriority(
  icp_tier: string,
  is_icp: boolean,
  in_hubspot: boolean,
  contact_accuracy_score: number
): string {
  if (!is_icp) return "low";

  // High priority: Tier 4 (C-suite) with high accuracy
  if (icp_tier === "Tier 4 (Ultimate)" && contact_accuracy_score >= 90) {
    return "high";
  }

  // High priority: Already in HubSpot + Tier 3/4
  if (in_hubspot && (icp_tier.includes("Tier 4") || icp_tier.includes("Tier 3"))) {
    return "high";
  }

  // Medium priority: Tier 2/3 with good accuracy
  if ((icp_tier.includes("Tier 2") || icp_tier.includes("Tier 3")) && contact_accuracy_score >= 70) {
    return "medium";
  }

  // Default to low for Tier 0/1 or low accuracy
  return "low";
}

/** Infer persona from job title keywords */
function inferPersonaFromTitle(title: string): string | null {
  const t = title.toLowerCase();

  // Quality & EHS
  if (t.includes('quality') || t.includes('food safety') || t.includes('fsqa') ||
      t.includes('ehs') || t.includes('safety') || t.includes('compliance') ||
      t.includes('regulatory') || t.includes('audit')) {
    return PERSONA_IDS.QUALITY_EHS;
  }

  // IT
  if (t.includes('information technology') || t.includes(' it ') || t.includes('it ') ||
      t.includes('technology') || t.includes('digital') || t.includes('software') ||
      t.includes('systems') || t.includes('data') || t.includes('cyber')) {
    return PERSONA_IDS.IT;
  }

  // Supply Chain & Procurement
  if (t.includes('supply chain') || t.includes('procurement') || t.includes('sourcing') ||
      t.includes('logistics') || t.includes('warehouse') || t.includes('distribution')) {
    return PERSONA_IDS.SUPPLY_CHAIN;
  }

  // Engineering & Continuous Improvement
  if (t.includes('engineering') || t.includes('engineer') || t.includes('continuous improvement') ||
      t.includes('process improvement') || t.includes('lean') || t.includes('six sigma')) {
    return PERSONA_IDS.ENGINEERING;
  }

  // Maintenance
  if (t.includes('maintenance') || t.includes('facilities') || t.includes('reliability')) {
    return PERSONA_IDS.MAINTENANCE;
  }

  // Plant Leadership (plant/site/facility manager/director)
  if (t.includes('plant manager') || t.includes('site manager') || t.includes('facility manager') ||
      t.includes('general manager') || t.includes('plant director')) {
    return PERSONA_IDS.PLANT_LEADERSHIP;
  }

  // Production/Operations
  if (t.includes('production') || t.includes('operations') || t.includes('manufacturing') ||
      t.includes('processing')) {
    return PERSONA_IDS.PRODUCTION;
  }

  // Corporate Management (CEO, CFO, COO, President, etc.)
  if (t.includes('chief') || t.includes('ceo') || t.includes('cfo') || t.includes('coo') ||
      t.includes('president') || t.includes('owner') || t.includes('founder')) {
    return PERSONA_IDS.CORPORATE;
  }

  return null; // Unknown persona
}

/** Save an AI-classified title to the database for future matching */
async function saveAiLearnedTitle(
  originalTitle: string,
  normalizedTitle: string,
  tier: string
): Promise<void> {
  // Check if title already exists (case-insensitive)
  const { data: existing } = await supabase
    .from('titles')
    .select('id')
    .ilike('title', originalTitle)
    .single();

  if (existing) {
    // Already in DB, skip
    return;
  }

  // Infer persona from title keywords
  const personaId = inferPersonaFromTitle(originalTitle);

  // Insert new AI-learned title
  const { error } = await supabase.from('titles').insert({
    title: originalTitle,
    tier: tier,
    normalized_title: normalizedTitle,
    primary_persona: personaId,
    notes: 'AI-classified via contact search',
  });

  if (error) {
    console.log("    Failed to save AI-learned title: " + error.message);
  } else {
    console.log("    Saved AI-learned title to DB: " + originalTitle + " -> " + tier);
  }
}

export async function searchAndEnrichContacts(
  request: ContactSearchRequest,
  ziUsername: string,
  ziPassword: string,
  ziAuthUrl: string,
  ziSearchUrl: string,
  ziEnrichUrl: string,
  hubspotToken?: string
): Promise<ContactSearchResult> {
  const managementLevels = request.management_levels?.length
    ? request.management_levels
    : DEFAULT_MANAGEMENT_LEVELS;
  const maxResults = Math.min(request.max_results || DEFAULT_MAX_RESULTS, MAX_RESULTS_LIMIT);
  const startPage = request.page || 1;
  const shouldEnrich = request.enrich_contacts === true;
  const skipCached = request.skip_cached || false;
  const autoPaginate = request.auto_paginate === true;

  console.log("\n Contact Search: " + (request.company_domain || request.company_name));
  console.log("   Filters: " + (managementLevels.join(', ')));
  console.log("   Max results per page: " + (maxResults) + (autoPaginate ? ' (auto-paginating all pages)' : ", Page: " + startPage));

  // Early company lookup to determine if small company (affects search filters)
  let isSmallCompany = false;
  if (request.company_domain) {
    const { data: companyData } = await supabase
      .from('companies')
      .select('company_size')
      .eq('domain', request.company_domain)
      .single();

    if (companyData?.company_size && SMALL_COMPANY_SIZES.includes(companyData.company_size)) {
      isSmallCompany = true;
      console.log("   Small company detected (" + companyData.company_size + ") - including executive titles");
    }
  }

  // Get JWT token (mutable to allow refresh on 401)
  let jwtToken = await getZoomInfoToken(ziUsername, ziPassword, ziAuthUrl);

  // Helper to make ZoomInfo API calls with automatic 401 retry
  const zoomInfoFetch = async (url: string, payload: any): Promise<Response> => {
    let response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + jwtToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // If 401, clear cache, get new token, and retry once
    if (response.status === 401) {
      console.log("    Got 401, refreshing JWT token...");
      clearTokenCache();
      jwtToken = await getZoomInfoToken(ziUsername, ziPassword, ziAuthUrl);
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + jwtToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    }

    return response;
  };

  // Build ZoomInfo search request template
  const buildSearchPayload = (pageNum: number) => {
    const payload: any = {
      rpp: maxResults,
      page: pageNum,
      managementLevel: managementLevels.join(','),
    };

    if (request.company_domain) {
      payload.companyWebsite = request.company_domain;
    }
    if (request.company_name) {
      payload.companyName = request.company_name;
    }
    // Pre-search filtering: use ICP keywords or caller-specified titles
    const useIcpFilter = request.use_icp_filter !== false; // default true
    if (request.job_titles?.length) {
      payload.jobTitle = request.job_titles.join(' OR ');
    } else if (useIcpFilter) {
      // For small companies, include executive titles alongside ICP keywords
      // This ensures we find CEOs, Founders, etc. who are often key contacts
      const titleKeywords = isSmallCompany
        ? [...ICP_JOB_TITLE_KEYWORDS, ...EXECUTIVE_TITLE_KEYWORDS]
        : ICP_JOB_TITLE_KEYWORDS;
      payload.jobTitle = titleKeywords.join(' OR ');
    }
    return payload;
  };

  // Fetch all pages if auto_paginate, otherwise just one page
  let searchData: any = null;
  let searchResults: ZoomInfoSearchContact[] = [];
  let totalResults = 0;
  let totalPages = 0;
  let pagesFetched = 0;

  if (autoPaginate) {
    console.log("    Auto-paginating through all results...");
    let currentPage = 1;
    let hasMore = true;

    while (hasMore) {
      const payload = buildSearchPayload(currentPage);
      const searchResponse = await zoomInfoFetch(ziSearchUrl, payload);

      if (!searchResponse.ok) {
        const errorText = await searchResponse.text();
        throw new Error('ZoomInfo Search API error (page ' + currentPage + '): ' + searchResponse.status + ' - ' + errorText);
      }

      const pageData = await searchResponse.json();
      if (pagesFetched === 0) {
        searchData = pageData; // Keep first page's metadata
        totalResults = pageData.totalResults || 0;
        totalPages = pageData.totalPages || Math.ceil(totalResults / maxResults);
        console.log("    Found " + totalResults + " total contacts across ~" + totalPages + " pages");
      }

      const pageContacts: ZoomInfoSearchContact[] = Array.isArray(pageData.data) ? pageData.data : [];
      searchResults.push(...pageContacts);
      pagesFetched++;

      console.log("    Page " + currentPage + ": " + pageContacts.length + " contacts (" + searchResults.length + " total so far)");

      // Check if there are more pages
      hasMore = currentPage < totalPages && pageContacts.length > 0;
      currentPage++;
    }
  } else {
    // Single page request
    const payload = buildSearchPayload(startPage);
    console.log("    Calling ZoomInfo Contact Search API...");

    const searchResponse = await zoomInfoFetch(ziSearchUrl, payload);

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      throw new Error('ZoomInfo Search API error: ' + searchResponse.status + ' - ' + errorText);
    }

    searchData = await searchResponse.json();
    totalResults = searchData.totalResults || 0;
    totalPages = searchData.totalPages || Math.ceil(totalResults / maxResults);
    searchResults = Array.isArray(searchData.data) ? searchData.data : [];
    pagesFetched = 1;

    console.log("    Found " + totalResults + " total contacts, " + searchResults.length + " on page " + startPage);
  }

  // Skip the duplicate log line when not auto-paginating
  if (autoPaginate) {
    console.log("    Fetched " + searchResults.length + " total contacts across " + pagesFetched + " pages");
  }

  // Filter out contacts with no contact data (unless disabled)
  const requireContactData = request.require_contact_data !== false; // default true
  let noContactDataFilteredCount = 0;

  if (requireContactData && searchResults.length > 0) {
    const originalCount = searchResults.length;
    searchResults = searchResults.filter(hasAnyContactData);
    noContactDataFilteredCount = originalCount - searchResults.length;
    if (noContactDataFilteredCount > 0) {
      console.log("    Filtered out " + noContactDataFilteredCount + " contacts with no contact data");
    }
  }

  // Look up company in our DB
  let company: { id?: string; domain?: string; company_name?: string; zoominfo_company_id?: string; hs_company_id?: string } = {
    domain: request.company_domain,
    company_name: request.company_name,
  };

  // Capture ZoomInfo company ID from raw search response
  // ZoomInfo search returns company info in various formats depending on API version
  if (searchData?.data?.[0]) {
    const rawFirst = searchData.data[0];
    const ziCompanyId = rawFirst.companyId || rawFirst.company?.id;
    if (ziCompanyId) {
      company.zoominfo_company_id = String(ziCompanyId);
      console.log("    ZoomInfo company ID: " + company.zoominfo_company_id);
    } else {
      // Log first result keys to debug what fields are available
      console.log("    ZoomInfo search result keys: " + Object.keys(rawFirst).join(', '));
    }
  }

  // Look up HubSpot company by ZoomInfo company ID
  if (company.zoominfo_company_id && hubspotToken) {
    try {
      const hsResponse = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + hubspotToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: 'zoominfo_company_id',
              operator: 'EQ',
              value: company.zoominfo_company_id,
            }],
          }],
          properties: ['name', 'domain', 'zoominfo_company_id'],
          limit: 1,
        }),
      });

      if (hsResponse.ok) {
        const hsData = await hsResponse.json();
        if (hsData.results?.length > 0) {
          company.hs_company_id = hsData.results[0].id;
          console.log("    HubSpot company match: " + company.hs_company_id + " (" + (hsData.results[0].properties?.name || '') + ")");
        } else {
          console.log("    No HubSpot company match for ZoomInfo ID " + company.zoominfo_company_id);
        }
      }
    } catch (err) {
      console.log("    HubSpot company lookup error: " + (err instanceof Error ? err.message : err));
    }
  }

  if (request.company_domain) {
    const { data: existingCompany } = await supabase
      .from('companies')
      .select('id, domain, company_name')
      .eq('domain', request.company_domain)
      .single();

    if (existingCompany) {
      company = { ...company, ...existingCompany };
    }
  }

  // HubSpot pre-check: find contacts already in HubSpot
  const checkHubspot = request.check_hubspot !== false; // default true
  let hubspotMatches = new Map<string, HubSpotMatch>();
  let hubspotCheckedCount = 0;

  // Inject company name into all search results since ZoomInfo company search
  // guarantees all returned contacts are from the searched company
  const companyNameForResults = request.company_name || company.company_name || '';
  if (companyNameForResults && searchResults.length > 0) {
    console.log("    Injecting company name into search results: " + companyNameForResults);
    for (const contact of searchResults) {
      // Only set if not already present (though ZoomInfo search typically doesn't include it)
      if (!contact.companyName) {
        contact.companyName = companyNameForResults;
      }
    }
  }

  if (checkHubspot && hubspotToken && searchResults.length > 0) {
    // Use company name from request, database lookup, or search results
    const companyNameForSearch = request.company_name || company.company_name || searchResults[0]?.companyName || '';
    if (companyNameForSearch) {
      hubspotMatches = await hubspotPreCheck(searchResults, companyNameForSearch, company.zoominfo_company_id, hubspotToken);
      hubspotCheckedCount = searchResults.length;
    }
  }

  // Enrich contacts by person ID via ZoomInfo Enrich API
  const enrichedContacts: ContactRecord[] = [];
  const errors: Array<{ contact: string; reason: string }> = [];
  const rawEnrichResponses: any[] = [];
  let enrichCredits = 0;
  let cachedCount = 0;
  let aiClassifiedCount = 0;

  if (shouldEnrich && searchResults.length > 0) {
    // Build batch enrich request using person IDs from search results
    // BUT skip contacts already in HubSpot
    const contactsToEnrich = searchResults.filter((sc) => {
      const firstName = (sc.firstName || '').toLowerCase().trim();
      const lastName = (sc.lastName || '').toLowerCase().trim();
      const key = firstName + "|" + lastName;
      return !hubspotMatches.has(key);
    });

    const enrichPayload: any = {
      matchPersonInput: contactsToEnrich.map((sc) => ({
        personId: String(sc.id),
      })),
      outputFields: [
        'id', 'firstName', 'lastName', 'email',
        'phone', 'mobilePhone',
        'jobTitle', 'companyName', 'companyId',
        'companyWebsite', 'city', 'state', 'country',
        'externalUrls',
      ],
    };

    const hubspotSkippedCount = searchResults.length - contactsToEnrich.length;
    if (hubspotSkippedCount > 0) {
      console.log("     Skipping " + hubspotSkippedCount + " contacts already in HubSpot");
    }
    console.log("    Enriching " + contactsToEnrich.length + " contacts by person ID...");

    const enrichResponse = await zoomInfoFetch(ziEnrichUrl, enrichPayload);

    if (!enrichResponse.ok) {
      const errorText = await enrichResponse.text();
      throw new Error('ZoomInfo Enrich API error: ' + enrichResponse.status + ' - ' + errorText);
    }

    const enrichData = await enrichResponse.json();
    rawEnrichResponses.push(enrichData);
    enrichCredits = enrichData.creditsUsed || searchResults.length;

    // Parse enriched results
    const enrichResults = enrichData.data?.result || [];
    for (const result of enrichResults) {
      if (!result.data || result.data.length === 0) {
        const input = result.input || {};
        errors.push({
          contact: input.personId || 'unknown',
          reason: result.matchStatus || 'No data returned',
        });
        continue;
      }

      const contact = result.data[0];
      const contactName = ((contact.firstName || '') + ' ' + (contact.lastName || '')).trim();
      const email = contact.email;

      if (!email) {
        errors.push({
          contact: contactName || String(contact.id),
          reason: 'No email in enrichment result',
        });
        continue;
      }

      // Check if already in DB
      if (!skipCached) {
        const { data: existing } = await supabase
          .from('contacts')
          .select('*')
          .eq('email_address', email)
          .single();

        if (existing) {
          console.log("    Cached: " + email);
          enrichedContacts.push(existing);
          cachedCount++;
          continue;
        }
      }

      // Extract LinkedIn URL
      let linkedInUrl: string | undefined;
      if (contact.externalUrls && Array.isArray(contact.externalUrls)) {
        const li = contact.externalUrls.find((u: any) =>
          u.type === 'LINKEDIN' || u.url?.includes('linkedin.com')
        );
        if (li) linkedInUrl = li.url;
      }

      // Check if this contact is in HubSpot
      const firstName = (contact.firstName || '').toLowerCase().trim();
      const lastName = (contact.lastName || '').toLowerCase().trim();
      const key = firstName + "|" + lastName;
      const hsMatch = hubspotMatches.get(key);

      // Build contact record
      const contactRecord: ContactRecord = {
        hubspot_company_id: request.hs_company_id || undefined,
        company_id: company.id || undefined,
        email_address: email,
        first_name: contact.firstName,
        last_name: contact.lastName,
        full_name: contact.firstName && contact.lastName
          ? contact.firstName + " " + contact.lastName
          : undefined,
        job_title: contact.jobTitle,
        direct_phone: contact.directPhone || contact.phone,
        cell_phone: contact.mobilePhone,
        linked_profile_url: linkedInUrl,
      };

      // Add HubSpot match info if found (with company verification)
      if (hsMatch) {
        // Priority 1: Email match (most reliable)
        const emailMatches = email && hsMatch.email &&
          email.toLowerCase() === hsMatch.email.toLowerCase();

        // Priority 2: Company match (ZoomInfo ID or name)
        const companyMatches = compareCompanyMatch(
          company.zoominfo_company_id,
          hsMatch.company_zoominfo_id,
          contact.companyName,
          hsMatch.company
        );

        if (emailMatches) {
          // Email match = highest confidence
          (contactRecord as any).in_hubspot = true;
          (contactRecord as any).hs_contact_id = hsMatch.hs_contact_id;
          (contactRecord as any).match_confidence = 'exact';
        } else if (companyMatches) {
          // Name + company match = high confidence
          (contactRecord as any).in_hubspot = true;
          (contactRecord as any).hs_contact_id = hsMatch.hs_contact_id;
          (contactRecord as any).match_confidence = 'high';
        } else {
          // Name matches but different company = likely false positive
          (contactRecord as any).in_hubspot = false;
          (contactRecord as any).match_confidence = 'name_only_mismatch';
          console.log("    ⚠️  HubSpot match rejected: " + contact.firstName + " " + contact.lastName +
            " at " + (contact.companyName || 'unknown') +
            " != " + (hsMatch.company || 'unknown'));
        }
      }

      // Save to DB
      try {
        const { data: existing } = await supabase
          .from('contacts')
          .select('*')
          .eq('email_address', email)
          .single();

        let savedContact;
        if (existing) {
          const { data } = await supabase
            .from('contacts')
            .update(contactRecord)
            .eq('id', existing.id)
            .select()
            .single();
          savedContact = data;
        } else {
          const { data } = await supabase
            .from('contacts')
            .insert(contactRecord)
            .select()
            .single();
          savedContact = data;
        }

        if (savedContact) {
          enrichedContacts.push(savedContact);
          console.log("    Saved: " + email);
        }
      } catch (err) {
        errors.push({
          contact: email,
          reason: err instanceof Error ? err.message : 'DB save error',
        });
      }
    }
  } else {
    // No enrichment - return search results with tier tagging
    const titlesCache = await loadTitlesCache();
    console.log("     Tier tagging " + searchResults.length + " contacts against " + titlesCache.length + " titles...");

    for (const sc of searchResults) {
      const tierMatch = sc.jobTitle
        ? matchTitleFromCache(sc.jobTitle, titlesCache)
        : { tier: 'Tier 0 (Unknown)', tier_rank: 0, matched_title: null, primary_persona: null };

      // Check if in HubSpot (with company verification)
      const key = (sc.firstName || '').toLowerCase().trim() + "|" + (sc.lastName || '').toLowerCase().trim();
      const hsMatch = hubspotMatches.get(key);

      let inHubSpot = false;
      let hsContactId: string | undefined = undefined;
      let matchConfidence: string | undefined = undefined;

      if (hsMatch) {
        // Verify company match (ZoomInfo ID or name) before flagging as in_hubspot
        const companyMatches = compareCompanyMatch(
          company.zoominfo_company_id,
          hsMatch.company_zoominfo_id,
          sc.companyName,
          hsMatch.company
        );

        if (companyMatches) {
          inHubSpot = true;
          hsContactId = hsMatch.hs_contact_id;
          matchConfidence = 'high';
        } else {
          // Name matches but different company = false positive
          matchConfidence = 'name_only_mismatch';
          console.log("    ⚠️  HubSpot match rejected: " + sc.firstName + " " + sc.lastName +
            " at " + (sc.companyName || 'unknown') +
            " != " + (hsMatch.company || 'unknown'));
        }
      }

      const contactRecord = {
        email_address: '',
        first_name: sc.firstName,
        last_name: sc.lastName,
        full_name: sc.firstName && sc.lastName ? sc.firstName + " " + sc.lastName : undefined,
        job_title: sc.jobTitle,
        zoominfo_person_id: String(sc.id),
        contact_accuracy_score: sc.contactAccuracyScore,
        valid_date: sc.validDate,
        last_updated_date: sc.lastUpdatedDate,
        has_email: sc.hasEmail,
        has_supplemental_email: sc.hasSupplementalEmail,
        has_direct_phone: sc.hasDirectPhone,
        has_mobile_phone: sc.hasMobilePhone,
        icp_tier: tierMatch.tier,
        icp_tier_rank: tierMatch.tier_rank,
        icp_matched_title: tierMatch.matched_title,
        lookup_persona: tierMatch.primary_persona, // Persona ID from titles lookup table
        in_hubspot: inHubSpot,
        hs_contact_id: hsContactId,
        match_confidence: matchConfidence,
      } as any;

      enrichedContacts.push(contactRecord);
    }

    // AI fallback for Tier 0 contacts using classifyTier()
    const tier0Contacts = enrichedContacts.filter((c: any) => c.icp_tier_rank === 0 && c.job_title);
    if (tier0Contacts.length > 0) {
      console.log("    AI fallback: classifying " + tier0Contacts.length + " Tier 0 contacts...");
      for (const contact of tier0Contacts as any[]) {
        try {
          const tierResult = await classifyTier(contact.job_title);
          contact.icp_tier = tierResult.tierLabel;
          contact.icp_tier_rank = tierToRank(tierResult.tierLabel);
          contact.icp_matched_title = "AI: " + tierResult.normalizedTitle;
          aiClassifiedCount++;

          // Save AI-learned title to DB for future matching
          await saveAiLearnedTitle(
            contact.job_title,
            tierResult.normalizedTitle,
            tierResult.tierLabel
          );
        } catch (err) {
          console.log("    AI tier classification failed for " + contact.job_title + ": " + (err instanceof Error ? err.message : err));
        }
      }
    }

    // Sort by tier rank descending (highest tier first)
    enrichedContacts.sort((a: any, b: any) => (b.icp_tier_rank || 0) - (a.icp_tier_rank || 0));
  }

  // ICP exclusion tagging: check each contact's title against exclusion keywords
  const exclusionKeywords = await loadExclusionKeywords();
  let nonIcpCount = 0;

  if (exclusionKeywords.length > 0) {
    console.log("    Checking " + enrichedContacts.length + " contacts against " + exclusionKeywords.length + " ICP exclusion keywords...");

    for (const contact of enrichedContacts as any[]) {
      const exclusionMatch = contact.job_title
        ? checkExclusion(contact.job_title, exclusionKeywords)
        : null;

      if (exclusionMatch) {
        contact.is_icp = false;
        contact.icp_exclusion_reason = exclusionMatch.keyword;
        nonIcpCount++;
      } else {
        contact.is_icp = true;
        contact.icp_exclusion_reason = null;
      }
    }

    if (nonIcpCount > 0) {
      console.log("    Tagged " + nonIcpCount + " contacts as non-ICP");
    }
  } else {
    // No exclusion keywords - all contacts are ICP by default
    for (const contact of enrichedContacts as any[]) {
      contact.is_icp = true;
      contact.icp_exclusion_reason = null;
    }
  }

  // Populate buying committee fields (persona, status, reasoning, strategy, priority)
  console.log("    Populating buying committee fields for " + enrichedContacts.length + " contacts...");
  for (const contact of enrichedContacts as any[]) {
    // Get persona ID - prefer lookup from titles table, fall back to keyword inference
    const persona_id = contact.lookup_persona || inferPersonaFromTitle(contact.job_title || '');
    const persona_label = persona_id
      ? (PERSONA_LABELS[persona_id] || TIER_DEFAULT_PERSONAS[contact.icp_tier || 'Tier 0 (Unknown)'])
      : TIER_DEFAULT_PERSONAS[contact.icp_tier || 'Tier 0 (Unknown)'];

    // Determine status
    const status = determineContactStatus(
      contact.in_hubspot || false,
      contact.is_icp !== false,
      undefined // hubspot_lifecycle_stage not available in search
    );

    // Generate reasoning
    const reasoning = generateContactReasoning(
      contact.job_title || '',
      contact.icp_tier || 'Tier 0 (Unknown)',
      persona_label,
      contact.is_icp !== false,
      contact.icp_exclusion_reason || null,
      contact.match_confidence
    );

    // Generate engagement strategy
    const engagement_strategy = generateEngagementStrategy(
      persona_label,
      contact.icp_tier || 'Tier 0 (Unknown)',
      contact.in_hubspot || false,
      contact.has_email || false,
      contact.has_direct_phone || false
    );

    // Assign priority
    const priority = assignContactPriority(
      contact.icp_tier || 'Tier 0 (Unknown)',
      contact.is_icp !== false,
      contact.in_hubspot || false,
      contact.contact_accuracy_score || 0
    );

    // Set the new fields
    contact.persona = persona_id;
    contact.persona_label = persona_label;
    contact.status = status;
    contact.reasoning = reasoning;
    contact.engagement_strategy = engagement_strategy;
    contact.priority = priority;
  }

  // Optionally filter out non-ICP contacts
  const filterNonIcp = request.filter_non_icp === true;
  let filteredContacts = enrichedContacts;

  if (filterNonIcp && nonIcpCount > 0) {
    filteredContacts = enrichedContacts.filter((c: any) => c.is_icp === true);
    console.log("    Filtered out " + nonIcpCount + " non-ICP contacts (filter_non_icp=true)");
  }

  return {
    data: {
      company,
      contacts: filteredContacts,
      pagination: {
        page: startPage,
        page_size: maxResults,
        total_results: totalResults,
        total_pages: totalPages,
        has_more: startPage < totalPages,
      },
    },
    metadata: {
      search_filters: {
        management_levels: managementLevels,
        job_titles: request.job_titles,
        icp_keyword_filter: !request.job_titles?.length && (request.use_icp_filter !== false),
      },
      found_count: searchResults.length,
      ...(shouldEnrich ? {
        enriched_count: enrichedContacts.length - cachedCount,
        cached_count: cachedCount,
      } : {
        tier_tagged_count: enrichedContacts.length,
        ai_classified_count: aiClassifiedCount,
      }),
      ...(hubspotCheckedCount > 0 && {
        hubspot_checked_count: hubspotCheckedCount,
        hubspot_matched_count: hubspotMatches.size,
        enrichment_skipped_count: shouldEnrich ? hubspotMatches.size : undefined,
      }),
      ...(noContactDataFilteredCount > 0 && {
        no_contact_data_filtered_count: noContactDataFilteredCount,
      }),
      ...(nonIcpCount > 0 && {
        non_icp_count: nonIcpCount,
      }),
      failed_count: errors.length,
    },
    cost: {
      search_credits: 1,
      enrich_credits: enrichCredits,
      total_credits: 1 + enrichCredits,
    },
    errors,
    raw_search_response: searchData,
    raw_enrich_responses: rawEnrichResponses.length ? rawEnrichResponses : undefined,
  };
}

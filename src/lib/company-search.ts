import { supabase } from './supabase.js';
import { getZoomInfoToken, clearTokenCache } from './zoominfo-auth.js';

const DEFAULT_MAX_RESULTS = 25;
const MAX_RESULTS_LIMIT = 100;

// ZoomInfo country name mappings
const COUNTRY_MAP: Record<string, string> = {
  'US': 'United States',
  'CA': 'Canadian Provinces',
  'MX': 'Mexico',
  'PR': 'Puerto Rico',
};

const DEFAULT_COUNTRIES = ['US', 'CA', 'MX', 'PR'];
const DEFAULT_REVENUE_MIN = 10000; // $10M in thousands

export interface CompanySearchRequest {
  naics_codes?: string[];
  revenue_min?: number;
  revenue_max?: number;
  countries?: string[];
  company_name?: string;
  website?: string;
  city?: string;
  state?: string;
  employee_min?: number;
  employee_max?: number;
  exclude_defunct?: boolean;

  max_results?: number;
  page?: number;
  auto_paginate?: boolean;

  check_hubspot?: boolean;      // default true
  check_enriched?: boolean;     // default false
  filter_in_hubspot?: boolean;  // if false, exclude companies already in HubSpot
  hs_company_id?: string;
}

interface ZoomInfoCompanyResult {
  id: number;
  name?: string;
  website?: string;
  revenue?: string;
  revenueNum?: number;
  employeeCount?: number;
  naicsCodes?: Array<{ code: string; description?: string }> | string[];
  industry?: string;
  city?: string;
  state?: string;
  country?: string;
  companyType?: string;
  ticker?: string;
  [key: string]: any;
}

export interface CompanySearchResult {
  data: {
    companies: any[];
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
      naics_code_count: number;
      revenue_min: number;
      countries: string[];
    };
    found_count: number;
    in_hubspot_count: number;
    in_database_count?: number;
    new_companies_count: number;
  };
  cost: {
    search_credits: number;
  };
  raw_search_response?: any;
}

/**
 * Search ZoomInfo for ICP-matching companies.
 * Default: NAICS codes from DB, revenue >$10M, US/CA/MX/PR.
 * Cross-references HubSpot by default, database optionally.
 */
export async function searchIcpCompanies(
  request: CompanySearchRequest,
  ziUsername: string,
  ziPassword: string,
  ziAuthUrl: string,
  ziCompanySearchUrl: string,
  hubspotToken?: string
): Promise<CompanySearchResult> {
  const maxResults = Math.min(request.max_results || DEFAULT_MAX_RESULTS, MAX_RESULTS_LIMIT);
  const startPage = request.page || 1;
  const autoPaginate = request.auto_paginate === true;
  const revenueMin = request.revenue_min ?? DEFAULT_REVENUE_MIN;
  const countries = request.countries || DEFAULT_COUNTRIES;

  console.log("\n Company Search (Land & Expand)");

  // 1. Load target NAICS codes
  let naicsCodes: string[];
  if (request.naics_codes?.length) {
    naicsCodes = request.naics_codes;
    console.log("   Using " + naicsCodes.length + " caller-specified NAICS codes");
  } else {
    const { data: naicsData } = await supabase
      .from('naics_codes')
      .select('naics_code')
      .eq('target_icp', true);

    naicsCodes = (naicsData || []).map((n: any) => n.naics_code);
    console.log("   Loaded " + naicsCodes.length + " target ICP NAICS codes from DB");
  }

  if (naicsCodes.length === 0) {
    throw new Error('No NAICS codes available for search');
  }

  // Map country codes to ZoomInfo names
  const ziCountries = countries
    .map(c => COUNTRY_MAP[c] || c)
    .join(',');

  console.log("   Revenue min: $" + (revenueMin / 1000) + "M | Countries: " + countries.join(', '));

  // 2. Get JWT token
  let jwtToken = await getZoomInfoToken(ziUsername, ziPassword, ziAuthUrl);

  const zoomInfoFetch = async (url: string, payload: any): Promise<Response> => {
    let response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + jwtToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

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

  // 3. Split NAICS codes into batches that fit ZoomInfo's 500 char limit
  const NAICS_CHAR_LIMIT = 490; // buffer under 500
  const naicsBatches: string[][] = [];
  let currentBatch: string[] = [];
  let currentLen = 0;

  for (const code of naicsCodes) {
    const addLen = currentBatch.length > 0 ? code.length + 1 : code.length; // +1 for comma
    if (currentLen + addLen > NAICS_CHAR_LIMIT && currentBatch.length > 0) {
      naicsBatches.push(currentBatch);
      currentBatch = [code];
      currentLen = code.length;
    } else {
      currentBatch.push(code);
      currentLen += addLen;
    }
  }
  if (currentBatch.length > 0) naicsBatches.push(currentBatch);

  console.log("   NAICS codes split into " + naicsBatches.length + " batch(es)");

  const buildSearchPayload = (pageNum: number, naicsBatch: string[]) => {
    const payload: any = {
      naicsCodes: naicsBatch.join(','),
      revenueMin: revenueMin,
      country: ziCountries,
      excludeDefunctCompanies: request.exclude_defunct !== false,
      rpp: maxResults,
      page: pageNum,
      sortBy: 'revenue',
      sortOrder: 'desc',
    };

    if (request.company_name) {
      payload.companyName = request.company_name;
    }
    if (request.website) {
      payload.website = request.website;
    }
    if (request.city) {
      payload.city = request.city;
    }
    if (request.state) {
      payload.state = request.state;
    }
    if (request.revenue_max !== undefined) {
      payload.revenueMax = request.revenue_max;
    }
    // Note: ZoomInfo doesn't support employeeMin/employeeMax as search filters
    // Employee filtering is done post-fetch below

    return payload;
  };

  // 4. Fetch results — run each NAICS batch as a separate search, deduplicate by company ID
  let searchData: any = null;
  const allResultsMap = new Map<number, ZoomInfoCompanyResult>(); // dedupe by id
  let totalResults = 0;
  let pagesFetched = 0;

  for (let batchIdx = 0; batchIdx < naicsBatches.length; batchIdx++) {
    const naicsBatch = naicsBatches[batchIdx];
    console.log("    Batch " + (batchIdx + 1) + "/" + naicsBatches.length + ": " + naicsBatch.length + " NAICS codes");

    if (autoPaginate) {
      let currentPage = 1;
      let hasMore = true;

      while (hasMore) {
        const payload = buildSearchPayload(currentPage, naicsBatch);
        const response = await zoomInfoFetch(ziCompanySearchUrl, payload);

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error('ZoomInfo Company Search API error (batch ' + (batchIdx + 1) + ', page ' + currentPage + '): ' + response.status + ' - ' + errorText);
        }

        const pageData = await response.json();
        if (!searchData) searchData = pageData;
        const batchTotal = pageData.maxResults || 0;
        const batchPages = Math.ceil(batchTotal / maxResults);

        const pageCompanies: ZoomInfoCompanyResult[] = Array.isArray(pageData.data) ? pageData.data : [];
        for (const c of pageCompanies) {
          if (c.id && !allResultsMap.has(c.id)) allResultsMap.set(c.id, c);
        }
        pagesFetched++;

        console.log("      Page " + currentPage + ": " + pageCompanies.length + " results (" + allResultsMap.size + " unique total)");

        hasMore = currentPage < batchPages && pageCompanies.length > 0;
        currentPage++;
      }
    } else {
      const payload = buildSearchPayload(startPage, naicsBatch);
      console.log("    Calling ZoomInfo Company Search API...");

      const response = await zoomInfoFetch(ziCompanySearchUrl, payload);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error('ZoomInfo Company Search API error: ' + response.status + ' - ' + errorText);
      }

      const pageData = await response.json();
      if (!searchData) searchData = pageData;
      totalResults += pageData.maxResults || 0;

      const pageCompanies: ZoomInfoCompanyResult[] = Array.isArray(pageData.data) ? pageData.data : [];
      for (const c of pageCompanies) {
        if (c.id && !allResultsMap.has(c.id)) allResultsMap.set(c.id, c);
      }
      pagesFetched++;

      console.log("      " + pageCompanies.length + " results (" + allResultsMap.size + " unique total)");
    }
  }

  let searchResults = Array.from(allResultsMap.values());

  // Post-fetch employee count filtering (ZoomInfo doesn't support these as search params)
  if (request.employee_min !== undefined || request.employee_max !== undefined) {
    const before = searchResults.length;
    searchResults = searchResults.filter(c => {
      const count = c.employeeCount ?? 0;
      if (request.employee_min !== undefined && count < request.employee_min) return false;
      if (request.employee_max !== undefined && count > request.employee_max) return false;
      return true;
    });
    console.log("    Employee filter: " + searchResults.length + "/" + before + " companies (min: " + (request.employee_min ?? 'none') + ", max: " + (request.employee_max ?? 'none') + ")");
  }

  // Sort by revenue descending (revenueNum field)
  searchResults.sort((a, b) => (b.revenueNum || 0) - (a.revenueNum || 0));

  const totalPages = Math.ceil(totalResults / maxResults);
  console.log("    Total unique companies: " + searchResults.length);

  // 5. Cross-reference HubSpot by ZoomInfo company ID (only reliable method)
  const checkHubspot = request.check_hubspot !== false;
  const hubspotMap = new Map<string, string>(); // ziCompanyId -> hsCompanyId

  if (checkHubspot && hubspotToken && searchResults.length > 0) {
    console.log("    HubSpot cross-reference: checking " + searchResults.length + " companies by ZI ID...");

    const allZiIds = searchResults.map(c => String(c.id)).filter(Boolean);
    // HubSpot filterGroups limit is 5 per request
    const ziIdBatches: string[][] = [];
    for (let i = 0; i < allZiIds.length; i += 5) {
      ziIdBatches.push(allZiIds.slice(i, i + 5));
    }

    for (const batch of ziIdBatches) {
      try {
        const filterGroups = batch.map(ziId => ({
          filters: [
            { propertyName: 'zoominfo_company_id', operator: 'EQ', value: ziId },
          ],
        }));

        const hsResponse = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + hubspotToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            filterGroups,
            properties: ['name', 'domain', 'zoominfo_company_id'],
            limit: 100,
          }),
        });

        if (hsResponse.ok) {
          const hsData = await hsResponse.json();
          for (const result of (hsData.results || [])) {
            const ziId = result.properties?.zoominfo_company_id;
            if (ziId) {
              hubspotMap.set(String(ziId), result.id);
            }
          }
        } else {
          const errText = await hsResponse.text();
          console.log("    HubSpot ZI ID search error: " + hsResponse.status + " - " + errText);
        }
      } catch (err) {
        console.log("    HubSpot ZI ID batch error: " + (err instanceof Error ? err.message : err));
      }
    }

    console.log("    HubSpot matches: " + hubspotMap.size + "/" + searchResults.length);
  }

  // 6. For unmatched companies, search DB by name for possible matches
  const checkEnriched = request.check_enriched === true;
  const possibleMatchMap = new Map<string, { company_name: string; domain: string; hs_company_id: string | null; target_account: boolean }>(); // ziId -> possible match

  if (searchResults.length > 0) {
    const unmatchedNames: Array<{ ziId: string; name: string }> = [];
    for (const c of searchResults) {
      const ziId = String(c.id);
      if (hubspotMap.has(ziId)) continue;
      if (c.name) {
        unmatchedNames.push({ ziId, name: c.name });
      }
    }

    if (unmatchedNames.length > 0) {
      console.log("    DB name search: checking " + unmatchedNames.length + " unmatched companies...");

      for (const { ziId, name } of unmatchedNames) {
        // Search by name using ilike for fuzzy matching
        const { data: matches } = await supabase
          .from('companies')
          .select('company_name, domain, hs_company_id, target_account')
          .ilike('company_name', '%' + name + '%')
          .limit(1);

        if (matches && matches.length > 0) {
          possibleMatchMap.set(ziId, {
            company_name: matches[0].company_name,
            domain: matches[0].domain,
            hs_company_id: matches[0].hs_company_id,
            target_account: matches[0].target_account,
          });
        }
      }

      console.log("    DB possible matches: " + possibleMatchMap.size + "/" + unmatchedNames.length);
    }
  }

  // 7. Build response companies
  const companies = searchResults.map(c => {
    const ziId = String(c.id);
    const hsCompanyId = hubspotMap.get(ziId);
    const possibleMatch = possibleMatchMap.get(ziId);

    const result: any = {
      zoominfo_company_id: ziId,
      company_name: c.name,
      website: c.website,
      revenue: c.revenue,
      revenue_numeric: c.revenueNum,
      employee_count: c.employeeCount,
      naics_codes: c.naicsCodes,
      industry: c.industry,
      city: c.city,
      state: c.state,
      country: c.country,
      company_type: c.companyType,
      ticker: c.ticker,
      in_hubspot: !!hsCompanyId,
      ...(hsCompanyId && { hs_company_id: hsCompanyId }),
      ...(possibleMatch && {
        possible_match: possibleMatch.company_name,
        possible_match_domain: possibleMatch.domain,
        possible_match_hs_id: possibleMatch.hs_company_id,
        possible_match_is_icp: possibleMatch.target_account,
      }),
    };

    return result;
  });

  const inHubspotCount = hubspotMap.size;
  const possibleMatchCount = possibleMatchMap.size;
  const inDatabaseCount = 0;
  const newCompaniesCount = companies.filter(c => !c.in_hubspot && !c.possible_match).length;

  // Filter out companies already in HubSpot (when filter_in_hubspot is false)
  let filteredCompanies = companies;
  if (request.filter_in_hubspot === false) {
    filteredCompanies = companies.filter(c => !c.in_hubspot);
    console.log("    Filtered to " + filteredCompanies.length + " companies NOT in HubSpot (removed " + (companies.length - filteredCompanies.length) + ")");
  }

  console.log("    Results: " + filteredCompanies.length + " companies | " + inHubspotCount + " in HubSpot | " + newCompaniesCount + " new");

  return {
    data: {
      companies: filteredCompanies,
      pagination: {
        page: startPage,
        page_size: maxResults,
        total_results: totalResults,
        total_pages: totalPages,
        has_more: autoPaginate ? false : startPage < totalPages,
      },
    },
    metadata: {
      search_filters: {
        naics_code_count: naicsCodes.length,
        revenue_min: revenueMin,
        countries,
      },
      found_count: filteredCompanies.length,
      in_hubspot_count: inHubspotCount,
      ...(checkEnriched && { in_database_count: inDatabaseCount }),
      new_companies_count: newCompaniesCount,
    },
    cost: {
      search_credits: pagesFetched,
    },
    raw_search_response: searchData,
  };
}

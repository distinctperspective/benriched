import { getZoomInfoToken, clearTokenCache } from './zoominfo-auth.js';

/**
 * Search for a specific person by name in ZoomInfo.
 * Unlike the company-based "land & expand" search, this searches directly
 * for an individual contact by firstName + lastName + companyName.
 *
 * Search returns: personId, firstName, lastName, companyId, companyName,
 * jobTitle, contactAccuracyScore, and boolean flags (hasEmail, hasDirectPhone, etc.)
 * Actual contact details (email, phone) require the enrich endpoint.
 */

export interface PersonSearchRequest {
  first_name: string;
  last_name: string;
  company_name?: string;
}

export interface PersonSearchResult {
  success: boolean;
  data: {
    zoominfo_person_id: string;
    full_name: string;
    first_name: string;
    last_name: string;
    job_title: string | null;
    contact_accuracy_score: number | null;
    company_name: string | null;
    zoominfo_company_id: string | null;
    has_email: boolean;
    has_direct_phone: boolean;
    has_mobile_phone: boolean;
  } | null;
  error?: string;
}

export async function searchPersonByName(
  request: PersonSearchRequest,
  ziUsername: string,
  ziPassword: string,
  ziAuthUrl: string,
  ziSearchUrl: string,
): Promise<PersonSearchResult> {
  console.log(`\n Person Search: ${request.first_name} ${request.last_name}` +
    (request.company_name ? ` at ${request.company_name}` : ''));

  let jwtToken = await getZoomInfoToken(ziUsername, ziPassword, ziAuthUrl);

  const zoomInfoFetch = async (url: string, payload: Record<string, unknown>): Promise<Response> => {
    let response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + jwtToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (response.status === 401) {
      console.log('    Got 401, refreshing JWT token...');
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

  // Build search payload with person name
  const payload: Record<string, unknown> = {
    rpp: 5,
    page: 1,
    firstName: request.first_name,
    lastName: request.last_name,
  };

  if (request.company_name) {
    payload.companyName = request.company_name;
  }

  console.log('    Calling ZoomInfo Contact Search API...');
  const searchResponse = await zoomInfoFetch(ziSearchUrl, payload);

  if (!searchResponse.ok) {
    const errorText = await searchResponse.text();
    console.error('    ZoomInfo search error:', searchResponse.status, errorText);
    return { success: false, data: null, error: `ZoomInfo API error: ${searchResponse.status}` };
  }

  const searchData = await searchResponse.json();
  const results: Array<Record<string, unknown>> = Array.isArray(searchData.data) ? searchData.data : [];

  console.log(`    Found ${results.length} results`);

  if (results.length === 0) {
    // If company name was provided and no results, retry without company filter
    if (request.company_name) {
      console.log('    Retrying without company name filter...');
      const retryPayload: Record<string, unknown> = {
        rpp: 5,
        page: 1,
        firstName: request.first_name,
        lastName: request.last_name,
      };

      const retryResponse = await zoomInfoFetch(ziSearchUrl, retryPayload);
      if (retryResponse.ok) {
        const retryData = await retryResponse.json();
        const retryResults: Array<Record<string, unknown>> = Array.isArray(retryData.data) ? retryData.data : [];
        console.log(`    Retry found ${retryResults.length} results`);

        if (retryResults.length > 0) {
          return formatResult(retryResults[0]);
        }
      }
    }

    return { success: true, data: null };
  }

  // Return the top match
  return formatResult(results[0]);
}

function formatResult(contact: Record<string, unknown>): PersonSearchResult {
  // Search API returns: personId, firstName, lastName, companyId, companyName,
  // jobTitle, contactAccuracyScore, hasEmail, hasDirectPhone, hasMobilePhone, etc.
  return {
    success: true,
    data: {
      zoominfo_person_id: String(contact.personId || contact.id),
      full_name: ((contact.firstName || '') + ' ' + (contact.lastName || '')).trim(),
      first_name: String(contact.firstName || ''),
      last_name: String(contact.lastName || ''),
      job_title: (contact.jobTitle as string) || null,
      contact_accuracy_score: (contact.contactAccuracyScore as number) || null,
      company_name: (contact.companyName as string) || null,
      zoominfo_company_id: contact.companyId ? String(contact.companyId) : null,
      has_email: contact.hasEmail === true,
      has_direct_phone: contact.hasDirectPhone === true,
      has_mobile_phone: contact.hasMobilePhone === true,
    },
  };
}

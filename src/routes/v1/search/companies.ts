import { Hono } from 'hono';
import { Context } from 'hono';
import { searchIcpCompanies, CompanySearchRequest } from '../../../lib/company-search.js';
import { saveEnrichmentRequest, EnrichmentRequestRecord } from '../../../lib/requests.js';

export async function handleCompanySearch(c: Context) {
  const requestStartTime = Date.now();

  try {
    const body = await c.req.json<CompanySearchRequest>();

    const ziUsername = c.env?.ZI_USERNAME || process.env.ZI_USERNAME;
    const ziPassword = c.env?.ZI_PASSWORD || process.env.ZI_PASSWORD;
    const ziAuthUrl = c.env?.ZI_AUTH_URL || process.env.ZI_AUTH_URL;
    const ziCompanySearchUrl = c.env?.ZI_COMPANY_SEARCH_URL || process.env.ZI_COMPANY_SEARCH_URL;
    const hubspotToken = c.env?.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;

    if (!ziUsername || !ziPassword || !ziAuthUrl || !ziCompanySearchUrl) {
      return c.json({ error: 'ZoomInfo credentials not configured' }, 500);
    }

    const result = await searchIcpCompanies(
      body,
      ziUsername,
      ziPassword,
      ziAuthUrl,
      ziCompanySearchUrl,
      hubspotToken
    );

    const responseTimeMs = Date.now() - requestStartTime;

    // Log the request
    const requestRecord: EnrichmentRequestRecord = {
      hs_company_id: body.hs_company_id || 'company_search',
      domain: body.company_name || 'icp_search',
      request_source: 'api',
      request_type: 'company-search',
      was_cached: false,
      cost_usd: result.cost.search_credits,
      response_time_ms: responseTimeMs,
      raw_api_responses: {
        zoominfo: result.raw_search_response,
      },
    };

    await saveEnrichmentRequest(requestRecord);

    return c.json({
      success: true,
      data: result.data,
      metadata: result.metadata,
      cost: result.cost,
      response_time_ms: responseTimeMs,
    });
  } catch (error) {
    console.error('Company search error:', error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      },
      500
    );
  }
}

const app = new Hono();
app.post('/', handleCompanySearch);

export default app;

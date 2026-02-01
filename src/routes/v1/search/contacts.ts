import { Hono } from 'hono';
import { Context } from 'hono';
import { searchAndEnrichContacts, ContactSearchRequest } from '../../../lib/contact-search.js';
import { saveEnrichmentRequest, EnrichmentRequestRecord } from '../../../lib/requests.js';
import { AppEnv } from '../../../types.js';

export async function handleContactSearch(c: Context<AppEnv>) {
  const requestStartTime = Date.now();

  try {
    const body = await c.req.json<ContactSearchRequest>();

    if (!body.company_domain && !body.company_name) {
      return c.json({ error: 'Missing required field: company_domain or company_name' }, 400);
    }

    const ziUsername = (c.env as any)?.ZI_USERNAME || process.env.ZI_USERNAME;
    const ziPassword = (c.env as any)?.ZI_PASSWORD || process.env.ZI_PASSWORD;
    const ziAuthUrl = (c.env as any)?.ZI_AUTH_URL || process.env.ZI_AUTH_URL;
    const ziSearchUrl = (c.env as any)?.ZI_SEARCH_URL || process.env.ZI_SEARCH_URL;
    const ziEnrichUrl = (c.env as any)?.ZI_ENRICH_URL || process.env.ZI_ENRICH_URL;
    const hubspotToken = (c.env as any)?.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;

    if (!ziUsername || !ziPassword || !ziAuthUrl || !ziSearchUrl || !ziEnrichUrl) {
      return c.json({ error: 'ZoomInfo credentials not configured' }, 500);
    }

    const result = await searchAndEnrichContacts(
      body,
      ziUsername,
      ziPassword,
      ziAuthUrl,
      ziSearchUrl,
      ziEnrichUrl,
      hubspotToken
    );

    const responseTimeMs = Date.now() - requestStartTime;

    // Log the request
    const requestRecord: EnrichmentRequestRecord = {
      hs_company_id: body.hs_company_id || `search_${body.company_domain || body.company_name}`,
      domain: body.company_domain || body.company_name || 'unknown',
      company_id: result.data.company.id || undefined,
      user_id: c.get('userId') || null,
      request_source: 'api',
      request_type: 'contact-search',
      was_cached: false,
      cost_usd: result.cost.total_credits,
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
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (error) {
    console.error('Contact search error:', error);
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
app.post('/', handleContactSearch);

export default app;

import { Hono } from 'hono';
import { Context } from 'hono';
import { enrichContactWithZoomInfo, ContactEnrichRequest } from '../../../lib/contact-enrich.js';
import { saveEnrichmentRequest, EnrichmentRequestRecord } from '../../../lib/requests.js';

export async function handleContactEnrichment(c: Context) {
  const requestStartTime = Date.now();

  try {
    const body = await c.req.json<ContactEnrichRequest>();
    const { email, full_name, first_name, last_name, job_title, company_name, hs_company_id, hs_contact_id } = body;

    if (!email) {
      return c.json({ error: 'Missing required field: email' }, 400);
    }

    const ziUsername = c.env?.ZI_USERNAME || process.env.ZI_USERNAME;
    const ziPassword = c.env?.ZI_PASSWORD || process.env.ZI_PASSWORD;
    const ziAuthUrl = c.env?.ZI_AUTH_URL || process.env.ZI_AUTH_URL;
    const ziEnrichUrl = c.env?.ZI_ENRICH_URL || process.env.ZI_ENRICH_URL;

    if (!ziUsername || !ziPassword || !ziAuthUrl || !ziEnrichUrl) {
      return c.json({ error: 'ZoomInfo credentials not configured' }, 500);
    }

    // Call ZoomInfo enrichment
    const result = await enrichContactWithZoomInfo({
      email,
      full_name,
      first_name,
      last_name,
      job_title,
      company_name,
      hs_company_id,
      hs_contact_id,
    }, ziUsername, ziPassword, ziAuthUrl, ziEnrichUrl);

    const responseTimeMs = Date.now() - requestStartTime;

    // Log the request
    const requestRecord: EnrichmentRequestRecord = {
      hs_company_id: hs_contact_id || `contact_${email}`,
      domain: email,
      request_source: 'api',
      request_type: result.was_cached ? 'contact-cached' : 'contact-enrich',
      was_cached: result.was_cached || false,
      cost_usd: result.credits_used || 0,
      response_time_ms: responseTimeMs,
      raw_api_responses: result.rawResponse ? {
        zoominfo: result.rawResponse
      } : undefined,
    };

    await saveEnrichmentRequest(requestRecord);

    return c.json({
      success: result.success,
      data: result.data,
      was_cached: result.was_cached,
      credits_used: result.credits_used,
      response_time_ms: responseTimeMs,
    });

  } catch (error) {
    console.error('Contact enrichment error:', error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      },
      500
    );
  }
}

const app = new Hono();
app.post('/', handleContactEnrichment);

export default app;

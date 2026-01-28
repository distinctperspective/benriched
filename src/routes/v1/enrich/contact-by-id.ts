import { Hono } from 'hono';
import { Context } from 'hono';
import { enrichContactByZoomInfoId, ContactEnrichByIdRequest } from '../../../lib/contact-enrich.js';
import { saveEnrichmentRequest, EnrichmentRequestRecord } from '../../../lib/requests.js';

export async function handleContactEnrichmentById(c: Context) {
  const requestStartTime = Date.now();

  try {
    const body = await c.req.json<ContactEnrichByIdRequest>();
    const { zoominfo_person_id, hs_contact_id, hs_company_id, force_refresh } = body;

    if (!zoominfo_person_id) {
      return c.json({ error: 'Missing required field: zoominfo_person_id' }, 400);
    }

    const ziUsername = c.env?.ZI_USERNAME || process.env.ZI_USERNAME;
    const ziPassword = c.env?.ZI_PASSWORD || process.env.ZI_PASSWORD;
    const ziAuthUrl = c.env?.ZI_AUTH_URL || process.env.ZI_AUTH_URL;
    const ziEnrichUrl = c.env?.ZI_ENRICH_URL || process.env.ZI_ENRICH_URL;

    if (!ziUsername || !ziPassword || !ziAuthUrl || !ziEnrichUrl) {
      return c.json({ error: 'ZoomInfo credentials not configured' }, 500);
    }

    // Call ZoomInfo enrichment by person ID
    const result = await enrichContactByZoomInfoId({
      zoominfo_person_id,
      hs_contact_id,
      hs_company_id,
      force_refresh,
    }, ziUsername, ziPassword, ziAuthUrl, ziEnrichUrl);

    const responseTimeMs = Date.now() - requestStartTime;

    // Log the request
    const requestRecord: EnrichmentRequestRecord = {
      hs_company_id: hs_contact_id || `zi_person_${zoominfo_person_id}`,
      domain: result.data?.email_address || zoominfo_person_id,
      request_source: 'api',
      request_type: result.was_cached ? 'contact-cached' : 'contact-enrich-by-id',
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
      ...(result.error && { error: result.error }),
    });

  } catch (error) {
    console.error('Contact enrichment by ID error:', error);
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
app.post('/', handleContactEnrichmentById);

export default app;

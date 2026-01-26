import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { gateway } from '@ai-sdk/gateway';
import { enrichDomainWithCost } from '../enrichment/enrich.js';
import { saveCompany, getCompanyByDomain, CompanyRecord } from '../lib/supabase.js';
import { saveEnrichmentRequest, EnrichmentRequestRecord } from '../lib/requests.js';
import { enrichContactWithZoomInfo, ContactEnrichRequest } from '../lib/contact-enrich.js';
import { SSEEmitter, createSSEHeaders } from '../lib/sseEmitter.js';

const app = new Hono();

interface EnrichRequest {
  domain: string;
  hs_company_id?: string;
  force_refresh?: boolean;
}

// Model IDs for cost tracking
const SEARCH_MODEL_ID = 'perplexity/sonar-pro';
const ANALYSIS_MODEL_ID = 'openai/gpt-4o-mini';

app.post('/', async (c) => {
  const requestStartTime = Date.now();
  const shouldStream = c.req.query('stream') === 'true';

  // STREAMING MODE
  if (shouldStream) {
    return stream(c, async (writerStream) => {
      const emitter = new SSEEmitter(c, writerStream);

      try {
        const body = await c.req.json<EnrichRequest>();
        const { domain, hs_company_id, force_refresh = false } = body;

        if (!domain) {
          await emitter.error(new Error('Missing required field: domain'));
          return;
        }

        const normalizedDomain = domain.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

        // Set SSE headers
        c.header('Content-Type', 'text/event-stream');
        c.header('Cache-Control', 'no-cache');
        c.header('Connection', 'keep-alive');
        c.header('X-Accel-Buffering', 'no');

        // Check cache
        if (!force_refresh) {
          await emitter.emit({
            stage: 'cache_check',
            message: 'Checking for cached data...',
            status: 'started'
          });

          const { data: existingCompany } = await getCompanyByDomain(normalizedDomain);
          if (existingCompany) {
            await emitter.emit({
              stage: 'cache_check',
              message: 'Found cached data',
              status: 'complete'
            });

            // Track the request if hs_company_id provided
            if (hs_company_id) {
              const responseTimeMs = Date.now() - requestStartTime;
              const requestRecord: EnrichmentRequestRecord = {
                hs_company_id,
                domain: normalizedDomain,
                company_id: existingCompany.id,
                request_source: 'hubspot',
                request_type: 'cached',
                was_cached: true,
                cost_usd: 0,
                response_time_ms: responseTimeMs,
              };
              await saveEnrichmentRequest(requestRecord);
            }

            // Emit completion with cached data
            await emitter.complete(existingCompany, 0);
            return;
          }

          await emitter.emit({
            stage: 'cache_check',
            message: 'No cached data found',
            status: 'complete'
          });
        }

        const aiGatewayKey = c.env?.AI_GATEWAY_API_KEY || process.env.AI_GATEWAY_API_KEY;
        const firecrawlApiKey = c.env?.FIRECRAWL_API_KEY || process.env.FIRECRAWL_API_KEY;

        if (!aiGatewayKey) {
          await emitter.error(new Error('AI Gateway API key not configured'));
          return;
        }

        // Pass 1: Use Perplexity for web search
        const searchModel = gateway(SEARCH_MODEL_ID);

        // Pass 2: Use GPT-4o-mini for content analysis
        const analysisModel = gateway(ANALYSIS_MODEL_ID);

        // Use the unified enrichDomain function with cost tracking and emitter
        const result = await enrichDomainWithCost(
          normalizedDomain,
          searchModel,
          analysisModel,
          firecrawlApiKey,
          SEARCH_MODEL_ID,
          ANALYSIS_MODEL_ID,
          false,
          emitter
        );

        // Emit database save stage
        await emitter.emit({
          stage: 'database_save',
          message: 'Saving to database...',
          status: 'started'
        });

        // Save company to database
        const companyRecord: CompanyRecord = {
          domain: normalizedDomain,
          company_name: result.company_name,
          website: result.website,
          linkedin_url: result.linkedin_url,
          business_description: result.business_description,
          company_size: result.company_size,
          company_revenue: result.company_revenue,
          city: result.city,
          state: result.state,
          hq_country: result.hq_country,
          is_us_hq: result.is_us_hq,
          is_us_subsidiary: result.is_us_subsidiary,
          naics_codes_6_digit: result.naics_codes_6_digit || [],
          naics_codes_csv: result.naics_codes_csv,
          target_icp: result.target_icp,
          target_icp_matches: result.target_icp_matches || [],
          source_urls: result.source_urls || [],
          quality: result.quality,
          performance_metrics: result.performance,
          last_enriched_at: new Date().toISOString(),
          parent_company_name: result.parent_company_name || null,
          parent_company_domain: result.parent_company_domain || null,
          inherited_revenue: result.inherited_revenue || false,
          inherited_size: result.inherited_size || false,
        };

        const { data: savedCompany, error: saveError } = await saveCompany(companyRecord);

        if (saveError) {
          console.error('Error saving company to database:', saveError);
          await emitter.error(new Error('Failed to save company to database'));
          return;
        }

        await emitter.emit({
          stage: 'database_save',
          message: 'Database save complete',
          status: 'complete'
        });

        // Track the request
        if (savedCompany) {
          const responseTimeMs = Date.now() - requestStartTime;
          const effectiveHsCompanyId = hs_company_id || `api_${crypto.randomUUID()}`;
          const requestRecord: EnrichmentRequestRecord = {
            hs_company_id: effectiveHsCompanyId,
            domain: normalizedDomain,
            company_id: savedCompany.id,
            request_source: hs_company_id ? 'hubspot' : 'api',
            request_type: 'enrichment',
            was_cached: false,
            cost_usd: result.cost.total.costUsd,
            response_time_ms: responseTimeMs,
            raw_api_responses: result.raw_api_responses || null,
            enrichment_cost: result.cost || null,
          };
          await saveEnrichmentRequest(requestRecord);
        }

        // Emit final completion event with full data
        await emitter.complete(savedCompany || result, result.cost.total.costUsd);

      } catch (error) {
        console.error('Enrichment error:', error);
        await emitter.error(error instanceof Error ? error : new Error('Unknown error'));
      }
    });
  }

  // NON-STREAMING MODE (existing behavior)
  try {
    const body = await c.req.json<EnrichRequest>();
    const { domain, hs_company_id, force_refresh = false } = body;

    if (!domain) {
      return c.json({ error: 'Missing required field: domain' }, 400);
    }

    const normalizedDomain = domain.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

    // Check if we already have this company in the database (unless force_refresh)
    if (!force_refresh) {
      const { data: existingCompany } = await getCompanyByDomain(normalizedDomain);
      if (existingCompany) {
        console.log(`\n📦 Found existing company in database: ${existingCompany.company_name}`);

        // Track the request if hs_company_id provided
        if (hs_company_id) {
          const responseTimeMs = Date.now() - requestStartTime;
          const requestRecord: EnrichmentRequestRecord = {
            hs_company_id,
            domain: normalizedDomain,
            company_id: existingCompany.id,
            request_source: 'hubspot',
            request_type: 'cached',
            was_cached: true,
            cost_usd: 0,
            response_time_ms: responseTimeMs,
          };
          await saveEnrichmentRequest(requestRecord);
          console.log(`\n📝 Tracked request for HubSpot company: ${hs_company_id}`);
        }

        return c.json({
          success: true,
          data: existingCompany,
          cached: true,
          hs_company_id: hs_company_id || null
        });
      }
    }

    const aiGatewayKey = c.env?.AI_GATEWAY_API_KEY || process.env.AI_GATEWAY_API_KEY;
    const firecrawlApiKey = c.env?.FIRECRAWL_API_KEY || process.env.FIRECRAWL_API_KEY;

    if (!aiGatewayKey) {
      return c.json({ error: 'AI Gateway API key not configured' }, 500);
    }

    console.log(`\n🔑 Using AI Gateway with key: ${aiGatewayKey?.substring(0, 10)}...`);

    // Pass 1: Use Perplexity for web search
    const searchModel = gateway(SEARCH_MODEL_ID);

    // Pass 2: Use GPT-4o-mini for content analysis
    const analysisModel = gateway(ANALYSIS_MODEL_ID);

    // Use the unified enrichDomain function with cost tracking (NO emitter)
    const result = await enrichDomainWithCost(
      normalizedDomain,
      searchModel,
      analysisModel,
      firecrawlApiKey,
      SEARCH_MODEL_ID,
      ANALYSIS_MODEL_ID
    );

    // Save company to database
    const companyRecord: CompanyRecord = {
      domain: normalizedDomain,
      company_name: result.company_name,
      website: result.website,
      linkedin_url: result.linkedin_url,
      business_description: result.business_description,
      company_size: result.company_size,
      company_revenue: result.company_revenue,
      city: result.city,
      state: result.state,
      hq_country: result.hq_country,
      is_us_hq: result.is_us_hq,
      is_us_subsidiary: result.is_us_subsidiary,
      naics_codes_6_digit: result.naics_codes_6_digit || [],
      naics_codes_csv: result.naics_codes_csv,
      target_icp: result.target_icp,
      target_icp_matches: result.target_icp_matches || [],
      source_urls: result.source_urls || [],
      quality: result.quality,
      performance_metrics: result.performance,
      last_enriched_at: new Date().toISOString(),
      // Parent company linking
      parent_company_name: result.parent_company_name || null,
      parent_company_domain: result.parent_company_domain || null,
      inherited_revenue: result.inherited_revenue || false,
      inherited_size: result.inherited_size || false,
    };

    const { data: savedCompany, error: saveError } = await saveCompany(companyRecord);

    if (saveError) {
      console.error('Error saving company to database:', saveError);
    } else {
      console.log(`\n💾 Saved company to database: ${savedCompany?.company_name}`);
    }

    // Always track the request with raw_api_responses
    // Generate a unique ID if no hs_company_id provided
    if (savedCompany) {
      const responseTimeMs = Date.now() - requestStartTime;
      const effectiveHsCompanyId = hs_company_id || `api_${crypto.randomUUID()}`;
      const requestRecord: EnrichmentRequestRecord = {
        hs_company_id: effectiveHsCompanyId,
        domain: normalizedDomain,
        company_id: savedCompany.id,
        request_source: hs_company_id ? 'hubspot' : 'api',
        request_type: 'enrichment',
        was_cached: false,
        cost_usd: result.cost.total.costUsd,
        response_time_ms: responseTimeMs,
        raw_api_responses: result.raw_api_responses || null,
        enrichment_cost: result.cost || null,
      };
      const { error: requestError } = await saveEnrichmentRequest(requestRecord);
      if (requestError) {
        console.error('Error saving request:', requestError);
      } else {
        console.log(`\n📝 Tracked request: ${effectiveHsCompanyId}`);
      }
    }

    return c.json({
      success: true,
      data: result,
      cached: false,
      hs_company_id: hs_company_id || null,
      submitted_domain: domain,
      normalized_domain: normalizedDomain
    });
  } catch (error) {
    console.error('Enrichment error:', error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      },
      500
    );
  }
});

// Contact enrichment endpoint
app.post('/contact', async (c) => {
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
});

export default app;

import { Hono } from 'hono';
import { gateway } from '@ai-sdk/gateway';
import { enrichDomainWithCost } from '../enrichment/enrich.js';
import { saveCompany, getCompanyByDomain, CompanyRecord } from '../lib/supabase.js';
import { saveEnrichmentRequest, EnrichmentRequestRecord } from '../lib/requests.js';

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

    // Use the unified enrichDomain function with cost tracking
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
      hs_company_id: hs_company_id || null
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

export default app;

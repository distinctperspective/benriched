import type { VercelRequest, VercelResponse } from '@vercel/node';
import { gateway } from '@ai-sdk/gateway';
import { createClient } from '@supabase/supabase-js';
import { enrichDomainWithCost } from '../src/enrichment/enrich.js';

const SEARCH_MODEL_ID = 'perplexity/sonar-pro';
const ANALYSIS_MODEL_ID = 'openai/gpt-4o-mini';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_ANON_KEY || ''
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Health check
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return res.status(200).json({ status: 'ok', name: 'Benriched API', version: '0.1.0' });
  }

  // Only POST for /enrich
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth check
  const authHeader = req.headers.authorization;
  const apiKey = process.env.API_KEY || 'amlink21';
  
  console.log('Auth header received:', authHeader);
  console.log('Expected:', `Bearer ${apiKey}`);
  
  if (!authHeader || authHeader !== `Bearer ${apiKey}`) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      hint: 'Expected header: Authorization: Bearer <api_key>',
      received: authHeader || 'none'
    });
  }

  const requestStartTime = Date.now();

  try {
    const { domain, hs_company_id, force_refresh = false } = req.body || {};

    if (!domain) {
      return res.status(400).json({ error: 'Missing required field: domain' });
    }

    const normalizedDomain = domain.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

    // Check cache
    if (!force_refresh) {
      const { data: existingCompany } = await supabase
        .from('companies')
        .select('*')
        .eq('domain', normalizedDomain)
        .single();

      if (existingCompany) {
        if (hs_company_id) {
          const responseTimeMs = Date.now() - requestStartTime;
          await supabase.from('enrichment_requests').upsert({
            hs_company_id,
            domain: normalizedDomain,
            company_id: existingCompany.id,
            request_source: 'hubspot',
            was_cached: true,
            cost_usd: 0,
            response_time_ms: responseTimeMs,
          }, { onConflict: 'hs_company_id' });
        }

        return res.status(200).json({
          success: true,
          data: existingCompany,
          cached: true,
          hs_company_id: hs_company_id || null
        });
      }
    }

    const searchModel = gateway(SEARCH_MODEL_ID);
    const analysisModel = gateway(ANALYSIS_MODEL_ID);

    const result = await enrichDomainWithCost(
      normalizedDomain,
      searchModel,
      analysisModel,
      process.env.FIRECRAWL_API_KEY,
      SEARCH_MODEL_ID,
      ANALYSIS_MODEL_ID
    );

    // Save company
    const { data: savedCompany } = await supabase
      .from('companies')
      .upsert({
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
        enrichment_cost: result.cost,
        performance_metrics: result.performance,
      }, { onConflict: 'domain' })
      .select()
      .single();

    if (hs_company_id && savedCompany) {
      const responseTimeMs = Date.now() - requestStartTime;
      await supabase.from('enrichment_requests').upsert({
        hs_company_id,
        domain: normalizedDomain,
        company_id: savedCompany.id,
        request_source: 'hubspot',
        was_cached: false,
        cost_usd: result.cost.total.costUsd,
        response_time_ms: responseTimeMs,
      }, { onConflict: 'hs_company_id' });
    }

    return res.status(200).json({
      success: true,
      data: result,
      cached: false,
      hs_company_id: hs_company_id || null
    });
  } catch (error) {
    console.error('Enrichment error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    });
  }
}

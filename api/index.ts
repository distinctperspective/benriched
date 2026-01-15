import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { gateway } from '@ai-sdk/gateway';
import { createClient } from '@supabase/supabase-js';
import { enrichDomainWithCost } from '../src/enrichment/enrich.js';
import { randomUUID } from 'crypto';

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
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health' || req.url?.startsWith('/?'))) {
    return res.status(200).json({ status: 'ok', name: 'Benriched API', version: '0.1.0' });
  }

  // Accept both GET and POST for flexibility with HubSpot
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed', received: req.method });
  }

  // Get body from POST or query params from GET
  const body = req.method === 'POST' ? req.body : req.query;

  // Auth check - supports multiple methods
  const authHeader = req.headers.authorization;
  const xApiKey = req.headers['x-api-key'] as string;
  const apiKeyHeader = req.headers['api_key'] as string || req.headers['api-key'] as string;
  const queryApiKey = req.query?.api_key as string;
  const bodyApiKey = body?.api_key as string;
  const apiKey = process.env.API_KEY || 'amlink21';
  
  const isAuthorized = 
    authHeader === `Bearer ${apiKey}` ||
    xApiKey === apiKey ||
    apiKeyHeader === apiKey ||
    queryApiKey === apiKey ||
    bodyApiKey === apiKey;
  
  if (!isAuthorized) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      hint: 'Include api_key in body, query, X-API-Key header, or Authorization: Bearer <key>',
    });
  }

  const requestStartTime = Date.now();

  try {
    const { domain, hs_company_id, hs_object_id, force_refresh = false, async = false } = body || {};
    const companyId = hs_company_id || hs_object_id; // Support both field names
    const requestId = randomUUID();

    if (!domain) {
      return res.status(400).json({ error: 'Missing required field: domain' });
    }

    // Normalize domain: strip protocol, www, trailing slash, and extract root domain
    let normalizedDomain = (domain as string)
      .toLowerCase()
      .replace(/^https?:\/\//, '')  // Remove protocol
      .replace(/^www\./, '')         // Remove www.
      .replace(/\/.*$/, '')          // Remove path
      .trim();
    
    // Extract root domain (e.g., "shop.example.com" -> "example.com")
    const parts = normalizedDomain.split('.');
    if (parts.length > 2) {
      // Keep last two parts for most TLDs (example.com)
      // Handle .co.uk, .com.au style TLDs
      const knownTwoPartTlds = ['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.br'];
      const lastTwo = parts.slice(-2).join('.');
      if (knownTwoPartTlds.includes(lastTwo)) {
        normalizedDomain = parts.slice(-3).join('.');
      } else {
        normalizedDomain = parts.slice(-2).join('.');
      }
    }

    // Check cache
    if (!force_refresh) {
      const { data: existingCompany } = await supabase
        .from('companies')
        .select('*')
        .eq('domain', normalizedDomain)
        .single();

      if (existingCompany) {
        // Log the request (always, even without hs_company_id)
        const responseTimeMs = Date.now() - requestStartTime;
        await supabase.from('enrichment_requests').insert({
          hs_company_id: companyId || `api_${requestId}`,
          domain: normalizedDomain,
          company_id: existingCompany.id,
          request_source: companyId ? 'hubspot' : 'api',
          request_type: 'cache_hit',
          was_cached: true,
          cost_usd: 0,
          response_time_ms: responseTimeMs,
        });

        return res.status(200).json({
          success: true,
          data: existingCompany,
          cached: true,
          hs_company_id: companyId || null
        });
      }
    }

    // Async enrichment function
    const doEnrichment = async () => {
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

      // Log the request (always, even without hs_company_id)
      // Determine request type based on whether this was a force_refresh or new enrichment
      const requestType = force_refresh ? 'force_refresh' : 'new_enrichment';
      
      if (savedCompany) {
        const responseTimeMs = Date.now() - requestStartTime;
        await supabase.from('enrichment_requests').insert({
          hs_company_id: companyId || `api_${requestId}`,
          domain: normalizedDomain,
          company_id: savedCompany.id,
          request_source: companyId ? 'hubspot' : 'api',
          request_type: requestType,
          was_cached: false,
          cost_usd: result.cost.total.costUsd,
          response_time_ms: responseTimeMs,
        });
      }

      return result;
    };

    // If async mode, return immediately and process in background
    if (async === true || async === 'true') {
      waitUntil(doEnrichment().catch(err => console.error('Background enrichment error:', err)));
      
      return res.status(202).json({
        success: true,
        status: 'processing',
        request_id: requestId,
        domain: normalizedDomain,
        hs_company_id: companyId || null,
        message: 'Enrichment started. Data will be saved to database when complete.'
      });
    }

    // Sync mode - wait for result
    const result = await doEnrichment();

    return res.status(200).json({
      success: true,
      data: result,
      cached: false,
      hs_company_id: companyId || null
    });
  } catch (error) {
    console.error('Enrichment error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    });
  }
}

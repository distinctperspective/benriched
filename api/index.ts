import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { gateway } from '@ai-sdk/gateway';
import { createClient } from '@supabase/supabase-js';
import { enrichDomainWithCost } from '../src/enrichment/enrich.js';
import { randomUUID } from 'crypto';
import { matchPersona } from '../src/lib/persona.js';
import { researchContact } from '../src/lib/research.js';
import { searchAndEnrichContacts, ContactSearchRequest } from '../src/lib/contact-search.js';
import { searchIcpCompanies, CompanySearchRequest } from '../src/lib/company-search.js';
import { enrichContactByZoomInfoId, ContactEnrichByIdRequest } from '../src/lib/contact-enrich.js';
import { searchPersonByName, PersonSearchRequest } from '../src/lib/contact-person-search.js';
import {
  addExclusionKeyword,
  addExclusionKeywords,
  removeExclusionKeyword,
  listExclusionKeywords,
} from '../src/lib/icp-exclusions.js';
import { saveEnrichmentRequest, EnrichmentRequestRecord } from '../src/lib/requests.js';

const SEARCH_MODEL_ID = 'perplexity/sonar-pro';
const ANALYSIS_MODEL_ID = 'openai/gpt-4o-mini';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

console.log(`[Supabase Init] Using key type: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'SERVICE_ROLE' : 'ANON'}`);

const supabase = createClient(supabaseUrl, supabaseKey);

async function handlePersonaMatch(req: VercelRequest, res: VercelResponse, title: string, save_mapping: boolean) {
  const requestStartTime = Date.now();
  
  try {
    // Use shared persona matching logic
    const result = await matchPersona(title, supabase, save_mapping);
    
    const responseTimeMs = Date.now() - requestStartTime;
    
    // Log request to enrichment_requests table
    await supabase.from('enrichment_requests').insert({
      hs_company_id: title,
      domain: title,
      request_source: 'persona-api',
      request_type: result.matched_from === 'database' ? 'persona-match-db' : 'persona-match-ai',
      was_cached: result.matched_from === 'database',
      cost_usd: result.cost?.costUsd || 0,
      response_time_ms: responseTimeMs,
      raw_api_responses: {
        pass1: JSON.stringify({
          matched_from: result.matched_from,
          primary_persona_id: result.primary_persona?.id,
          secondary_persona_id: result.secondary_persona?.id,
          confidence: result.confidence,
          reasoning: result.reasoning
        })
      },
      enrichment_cost: result.cost ? {
        ai: {
          pass1: {
            model: 'openai/gpt-4o-mini',
            inputTokens: result.cost.inputTokens,
            outputTokens: result.cost.outputTokens,
            totalTokens: result.cost.totalTokens,
            costUsd: result.cost.costUsd
          },
          total: {
            inputTokens: result.cost.inputTokens,
            outputTokens: result.cost.outputTokens,
            totalTokens: result.cost.totalTokens,
            costUsd: result.cost.costUsd
          }
        },
        total: {
          costUsd: result.cost.costUsd
        }
      } : undefined
    });

    return res.status(200).json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Persona matching error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    });
  }
}

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

  // Research contact endpoint
  if (req.url?.includes('/research/contact')) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    // Auth check
    const authHeader = req.headers.authorization;
    const xApiKey = req.headers['x-api-key'] as string;
    const queryApiKey = req.query?.api_key as string;
    const bodyApiKey = req.body?.api_key as string;
    const apiKey = process.env.API_KEY || 'amlink21';
    
    const isAuthorized = 
      authHeader === `Bearer ${apiKey}` ||
      xApiKey === apiKey ||
      queryApiKey === apiKey ||
      bodyApiKey === apiKey;
    
    if (!isAuthorized) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        hint: 'Include api_key in body, query, X-API-Key header, or Authorization: Bearer <key>',
      });
    }

    const { prospect_name, company_name, linkedin_url } = req.body || {};

    if (!prospect_name || !company_name) {
      return res.status(400).json({ error: 'Missing required fields: prospect_name and company_name' });
    }

    const requestStartTime = Date.now();

    try {
      // Use direct Perplexity API with web_search_options
      const perplexityApiKey = process.env.PERPLEXITY_API_KEY;
      
      if (!perplexityApiKey) {
        return res.status(500).json({ error: 'Perplexity API key not configured' });
      }

      // Call shared research function with direct Perplexity API
      const result = await researchContact({
        prospect_name,
        company_name,
        linkedin_url
      }, perplexityApiKey);

      const responseTimeMs = Date.now() - requestStartTime;

      // Log the request
      await supabase.from('enrichment_requests').insert({
        hs_company_id: `research_${randomUUID()}`,
        domain: prospect_name,
        request_source: 'api',
        request_type: 'contact-research',
        was_cached: false,
        cost_usd: result.cost.costUsd,
        response_time_ms: responseTimeMs,
        raw_api_responses: {
          pass1: result.rawResponse,
          pass2: JSON.stringify(result.data)
        },
        enrichment_cost: {
          ai: {
            pass1: {
              model: 'perplexity/sonar-pro',
              inputTokens: result.cost.inputTokens,
              outputTokens: result.cost.outputTokens,
              totalTokens: result.cost.totalTokens,
              costUsd: result.cost.costUsd
            },
            total: {
              inputTokens: result.cost.inputTokens,
              outputTokens: result.cost.outputTokens,
              totalTokens: result.cost.totalTokens,
              costUsd: result.cost.costUsd
            }
          },
          total: {
            costUsd: result.cost.costUsd
          }
        }
      });

      return res.status(200).json({
        success: true,
        data: result.data,
        metadata: {
          prospect_name,
          company_name,
          linkedin_url: linkedin_url || null,
          tokens: {
            input: result.cost.inputTokens,
            output: result.cost.outputTokens,
            total: result.cost.totalTokens
          },
          cost_usd: result.cost.costUsd,
          response_time_ms: responseTimeMs
        }
      });
    } catch (error) {
      console.error('Contact research error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      });
    }
  }

  // Person-specific contact search (search by name, not company)
  if (req.url?.includes('/search/contact') && !req.url?.includes('/search/contacts')) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    // Auth check
    const authHeader = req.headers.authorization;
    const xApiKey = req.headers['x-api-key'] as string;
    const queryApiKey = req.query?.api_key as string;
    const bodyApiKey = req.body?.api_key as string;
    const apiKey = process.env.API_KEY || 'amlink21';

    const isAuthorized =
      authHeader === `Bearer ${apiKey}` ||
      xApiKey === apiKey ||
      queryApiKey === apiKey ||
      bodyApiKey === apiKey;

    if (!isAuthorized) {
      return res.status(401).json({
        error: 'Unauthorized',
        hint: 'Include api_key in body, query, X-API-Key header, or Authorization: Bearer <key>',
      });
    }

    const body = req.body as PersonSearchRequest & { api_key?: string };

    if (!body.first_name || !body.last_name) {
      return res.status(400).json({ error: 'Missing required fields: first_name and last_name' });
    }

    const requestStartTime = Date.now();

    try {
      const ziUsername = process.env.ZI_USERNAME;
      const ziPassword = process.env.ZI_PASSWORD;
      const ziAuthUrl = process.env.ZI_AUTH_URL;
      const ziSearchUrl = process.env.ZI_SEARCH_URL;

      if (!ziUsername || !ziPassword || !ziAuthUrl || !ziSearchUrl) {
        return res.status(500).json({ error: 'ZoomInfo credentials not configured' });
      }

      const result = await searchPersonByName(
        body,
        ziUsername,
        ziPassword,
        ziAuthUrl,
        ziSearchUrl,
      );

      const responseTimeMs = Date.now() - requestStartTime;

      return res.status(200).json({
        ...result,
        response_time_ms: responseTimeMs,
      });
    } catch (error) {
      console.error('Person search error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  }

  // Contact search endpoint (v1 and legacy)
  if (req.url?.includes('/search/contacts') || req.url?.includes('/v1/search/contacts')) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    // Auth check
    const authHeader = req.headers.authorization;
    const xApiKey = req.headers['x-api-key'] as string;
    const queryApiKey = req.query?.api_key as string;
    const bodyApiKey = req.body?.api_key as string;
    const apiKey = process.env.API_KEY || 'amlink21';

    const isAuthorized =
      authHeader === `Bearer ${apiKey}` ||
      xApiKey === apiKey ||
      queryApiKey === apiKey ||
      bodyApiKey === apiKey;

    if (!isAuthorized) {
      return res.status(401).json({
        error: 'Unauthorized',
        hint: 'Include api_key in body, query, X-API-Key header, or Authorization: Bearer <key>',
      });
    }

    const body = req.body as ContactSearchRequest;

    if (!body.company_domain && !body.company_name) {
      return res.status(400).json({ error: 'Missing required field: company_domain or company_name' });
    }

    const requestStartTime = Date.now();

    try {
      const ziUsername = process.env.ZI_USERNAME;
      const ziPassword = process.env.ZI_PASSWORD;
      const ziAuthUrl = process.env.ZI_AUTH_URL;
      const ziSearchUrl = process.env.ZI_SEARCH_URL;
      const ziEnrichUrl = process.env.ZI_ENRICH_URL;
      const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;

      if (!ziUsername || !ziPassword || !ziAuthUrl || !ziSearchUrl || !ziEnrichUrl) {
        return res.status(500).json({ error: 'ZoomInfo credentials not configured' });
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
      await supabase.from('enrichment_requests').insert({
        hs_company_id: body.hs_company_id || `search_${body.company_domain || body.company_name}`,
        domain: body.company_domain || body.company_name || 'unknown',
        company_id: result.data.company.id || undefined,
        request_source: 'api',
        request_type: 'contact-search',
        was_cached: false,
        cost_usd: result.cost.total_credits,
        response_time_ms: responseTimeMs,
        raw_api_responses: {
          zoominfo: result.raw_search_response,
        },
      });

      return res.status(200).json({
        success: true,
        data: result.data,
        metadata: result.metadata,
        cost: result.cost,
        response_time_ms: responseTimeMs,
        errors: result.errors.length > 0 ? result.errors : undefined,
      });
    } catch (error) {
      console.error('Contact search error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  }

  // Company search endpoint (v1 and legacy)
  if (req.url?.includes('/search/companies') || req.url?.includes('/v1/search/companies')) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    // Auth check
    const authHeader = req.headers.authorization;
    const xApiKey = req.headers['x-api-key'] as string;
    const queryApiKey = req.query?.api_key as string;
    const bodyApiKey = req.body?.api_key as string;
    const apiKey = process.env.API_KEY || 'amlink21';

    const isAuthorized =
      authHeader === `Bearer ${apiKey}` ||
      xApiKey === apiKey ||
      queryApiKey === apiKey ||
      bodyApiKey === apiKey;

    if (!isAuthorized) {
      return res.status(401).json({
        error: 'Unauthorized',
        hint: 'Include api_key in body, query, X-API-Key header, or Authorization: Bearer <key>',
      });
    }

    const body = req.body as CompanySearchRequest;
    const requestStartTime = Date.now();

    try {
      const ziUsername = process.env.ZI_USERNAME;
      const ziPassword = process.env.ZI_PASSWORD;
      const ziAuthUrl = process.env.ZI_AUTH_URL;
      const ziCompanySearchUrl = process.env.ZI_COMPANY_SEARCH_URL;
      const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;

      if (!ziUsername || !ziPassword || !ziAuthUrl || !ziCompanySearchUrl) {
        return res.status(500).json({ error: 'ZoomInfo credentials not configured (missing ZI_COMPANY_SEARCH_URL)' });
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
      await supabase.from('enrichment_requests').insert({
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
      });

      return res.status(200).json({
        success: true,
        data: result.data,
        metadata: result.metadata,
        cost: result.cost,
        response_time_ms: responseTimeMs,
      });
    } catch (error) {
      console.error('Company search error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  }

  // Contact enrich by ZoomInfo ID endpoint
  if (req.url?.includes('/enrich/contact-by-id') || req.url?.includes('/v1/enrich/contact-by-id')) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    // Auth check
    const authHeader = req.headers.authorization;
    const xApiKey = req.headers['x-api-key'] as string;
    const queryApiKey = req.query?.api_key as string;
    const bodyApiKey = req.body?.api_key as string;
    const apiKey = process.env.API_KEY || 'amlink21';

    const isAuthorized =
      authHeader === `Bearer ${apiKey}` ||
      xApiKey === apiKey ||
      queryApiKey === apiKey ||
      bodyApiKey === apiKey;

    if (!isAuthorized) {
      return res.status(401).json({
        error: 'Unauthorized',
        hint: 'Include api_key in body, query, X-API-Key header, or Authorization: Bearer <key>',
      });
    }

    const body = req.body as ContactEnrichByIdRequest;

    if (!body.zoominfo_person_id) {
      return res.status(400).json({ error: 'Missing required field: zoominfo_person_id' });
    }

    const requestStartTime = Date.now();

    try {
      const ziUsername = process.env.ZI_USERNAME;
      const ziPassword = process.env.ZI_PASSWORD;
      const ziAuthUrl = process.env.ZI_AUTH_URL;
      const ziEnrichUrl = process.env.ZI_ENRICH_URL;
      const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;

      if (!ziUsername || !ziPassword || !ziAuthUrl || !ziEnrichUrl) {
        return res.status(500).json({ error: 'ZoomInfo credentials not configured' });
      }

      const result = await enrichContactByZoomInfoId(
        body,
        ziUsername,
        ziPassword,
        ziAuthUrl,
        ziEnrichUrl,
        hubspotToken
      );

      const responseTimeMs = Date.now() - requestStartTime;

      // Log the request
      await supabase.from('enrichment_requests').insert({
        hs_company_id: body.hs_contact_id || `zi_person_${body.zoominfo_person_id}`,
        domain: result.data?.email_address || body.zoominfo_person_id,
        request_source: 'api',
        request_type: result.was_cached ? 'contact-cached' : 'contact-enrich-by-id',
        was_cached: result.was_cached || false,
        cost_usd: result.credits_used || 0,
        response_time_ms: responseTimeMs,
        raw_api_responses: result.rawResponse ? {
          zoominfo: result.rawResponse
        } : undefined,
      });

      return res.status(200).json({
        success: result.success,
        data: result.data,
        was_cached: result.was_cached,
        credits_used: result.credits_used,
        response_time_ms: responseTimeMs,
        ...(result.error && { error: result.error }),
        ...(result.hubspot_updated !== undefined && { hubspot_updated: result.hubspot_updated }),
        ...(result.hubspot_created !== undefined && { hubspot_created: result.hubspot_created }),
        ...(result.hubspot_contact_id && { hubspot_contact_id: result.hubspot_contact_id }),
      });
    } catch (error) {
      console.error('Contact enrich by ID error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  }

  // ICP Exclusions endpoints
  if (req.url?.includes('/icp/exclusions')) {
    // Auth check
    const authHeader = req.headers.authorization;
    const xApiKey = req.headers['x-api-key'] as string;
    const queryApiKey = req.query?.api_key as string;
    const bodyApiKey = req.body?.api_key as string;
    const apiKey = process.env.API_KEY || 'amlink21';

    const isAuthorized =
      authHeader === `Bearer ${apiKey}` ||
      xApiKey === apiKey ||
      queryApiKey === apiKey ||
      bodyApiKey === apiKey;

    if (!isAuthorized) {
      return res.status(401).json({
        error: 'Unauthorized',
        hint: 'Include api_key in body, query, X-API-Key header, or Authorization: Bearer <key>',
      });
    }

    // POST - Add exclusion keyword(s)
    if (req.method === 'POST') {
      try {
        const body = req.body;

        // Handle batch (keywords array) or single (keyword string)
        if (body.keywords && Array.isArray(body.keywords)) {
          const result = await addExclusionKeywords(body.keywords, body.reason);

          return res.status(200).json({
            success: true,
            data: {
              added: result.added,
              already_exists: result.alreadyExists,
              errors: result.errors.length > 0 ? result.errors : undefined,
              count: result.added.length,
            },
          });
        } else if (body.keyword) {
          const result = await addExclusionKeyword(body.keyword, body.reason);

          if (result.alreadyExists) {
            return res.status(409).json({
              success: false,
              error: 'Keyword already exists',
              keyword: body.keyword,
            });
          }

          if (!result.success) {
            return res.status(400).json({
              success: false,
              error: result.error,
            });
          }

          return res.status(201).json({
            success: true,
            data: result.data,
          });
        } else {
          return res.status(400).json({
            success: false,
            error: 'Missing required field: keyword or keywords',
          });
        }
      } catch (error) {
        console.error('Add exclusion error:', error);
        return res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error occurred',
        });
      }
    }

    // GET - List all exclusion keywords
    if (req.method === 'GET') {
      try {
        const keywords = await listExclusionKeywords();

        return res.status(200).json({
          success: true,
          data: keywords,
          count: keywords.length,
        });
      } catch (error) {
        console.error('List exclusions error:', error);
        return res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error occurred',
        });
      }
    }

    // DELETE - Remove an exclusion keyword
    if (req.method === 'DELETE') {
      try {
        // Extract keyword from URL path: /v1/icp/exclusions/:keyword
        const urlParts = req.url?.split('/') || [];
        const keywordIndex = urlParts.findIndex(p => p === 'exclusions') + 1;
        const keyword = keywordIndex > 0 ? decodeURIComponent(urlParts[keywordIndex]?.split('?')[0] || '') : '';

        if (!keyword) {
          return res.status(400).json({
            success: false,
            error: 'Missing keyword parameter',
          });
        }

        const result = await removeExclusionKeyword(keyword);

        if (!result.success) {
          return res.status(400).json({
            success: false,
            error: result.error,
          });
        }

        return res.status(200).json({
          success: true,
          deleted: keyword,
        });
      } catch (error) {
        console.error('Delete exclusion error:', error);
        return res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error occurred',
        });
      }
    }

    return res.status(405).json({ error: 'Method not allowed. Use GET, POST, or DELETE.' });
  }

  // Persona matching endpoint
  if (req.url?.startsWith('/persona')) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }
    
    const { title, save_mapping = false } = req.body || {};
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    return handlePersonaMatch(req, res, title, save_mapping);
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
  const { domain, company_name, hs_company_id, hs_object_id, force_refresh = false, async = false, deep_research = false } = body || {};
  const companyId = hs_company_id || hs_object_id; // Support both field names
  const requestId = randomUUID();

  // Normalize domain early so it's available in catch block
  let normalizedDomain = '';
  
  if (!domain) {
    return res.status(400).json({ error: 'Missing required field: domain' });
  }

  try {
    // Normalize domain using WHATWG URL API for security and robustness
    let normalizedDomain = '';
    
    try {
      // Try to parse as URL first
      const url = new URL(domain.startsWith('http') ? domain : `https://${domain}`);
      normalizedDomain = url.hostname.toLowerCase();
    } catch {
      // If URL parsing fails, fall back to simple normalization
      normalizedDomain = (domain as string)
        .toLowerCase()
        .replace(/^https?:\/\//, '')  // Remove protocol
        .replace(/^www\./, '')         // Remove www.
        .replace(/\/.*$/, '')          // Remove path
        .trim();
    }
    
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
        
        console.log(`[Cache Hit] ${normalizedDomain} (cached, ${responseTimeMs}ms)`);
        
        try {
          await supabase.from('enrichment_requests').insert({
            hs_company_id: companyId || null, // Don't use api_${requestId} to avoid unique constraint issues
            domain: normalizedDomain,
            company_id: existingCompany.id,
            request_source: companyId ? 'hubspot' : 'api',
            request_type: 'cache_hit',
            was_cached: true,
            cost_usd: 0,
            response_time_ms: responseTimeMs,
          });
          console.log(`[Cache Log] Successfully logged cache hit for ${normalizedDomain}`);
        } catch (logError) {
          console.error('[Cache Log Error]', logError);
        }

        return res.status(200).json({
          success: true,
          data: existingCompany,
          cached: true,
          hs_company_id: companyId || null
        });
      }
    }

    // Check if company already exists (to determine if this is a retry vs new)
    const { data: existingBeforeEnrich } = await supabase
      .from('companies')
      .select('id')
      .eq('domain', normalizedDomain)
      .single();
    const companyExistedBefore = !!existingBeforeEnrich;

    // Additional validation: ensure no duplicate domains
    if (!force_refresh && companyExistedBefore) {
      console.log(`[Duplicate Domain] ${normalizedDomain} already exists, serving from cache`);
      const responseTimeMs = Date.now() - requestStartTime;
      await supabase.from('enrichment_requests').insert({
        hs_company_id: companyId || null,
        domain: normalizedDomain,
        company_id: existingBeforeEnrich.id,
        request_source: companyId ? 'hubspot' : 'api',
        request_type: 'cache_hit',
        was_cached: true,
        cost_usd: 0,
        response_time_ms: responseTimeMs,
      });

      return res.status(200).json({
        success: true,
        data: existingBeforeEnrich,
        cached: true,
        hs_company_id: companyId || null
      });
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
        ANALYSIS_MODEL_ID,
        deep_research as boolean,
        undefined,    // emitter
        company_name, // providedCompanyName
      );

      // Save company (include hs_company_id if provided)
      // Always use normalizedDomain for upsert key to avoid creating duplicates when domain resolves differently
      const companyData: Record<string, unknown> = {
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
        // target_icp removed - calculated by database trigger
        target_icp_matches: result.target_icp_matches || [],
        source_urls: result.source_urls || [],
        quality: result.quality,
        performance_metrics: result.performance,
        last_enriched_at: new Date().toISOString(),
        // Parent company linking
        parent_company_name: result.parent_company_name || null,
        parent_company_domain: result.parent_company_domain || null,
        parent_company_revenue: result.parent_company_revenue || null,
        inherited_revenue: result.inherited_revenue || false,
        inherited_size: result.inherited_size || false,
      };
      
      // Add hs_company_id if provided from HubSpot
      if (companyId) {
        companyData.hs_company_id = companyId;
      }
      
      const { data: savedCompany, error: upsertError } = await supabase
        .from('companies')
        .upsert(companyData, { onConflict: 'domain' })
        .select()
        .single();
      
      if (upsertError) {
        console.error('[Upsert Error]', upsertError);
        throw new Error(`Failed to upsert company: ${upsertError.message}`);
      }

      // Log the request (always, even without hs_company_id)
      // Determine request type: force_refresh, retry (existed but re-enriching), or new_enrichment
      // Also track if deep_research was used
      let requestType = 'new_enrichment';
      if (force_refresh && deep_research) {
        requestType = 'force_refresh_deep';
      } else if (force_refresh) {
        requestType = 'force_refresh';
      } else if (deep_research) {
        requestType = 'deep_research';
      } else if (companyExistedBefore) {
        requestType = 'retry'; // Company existed but we're re-enriching (likely after an error)
      }
      
      if (savedCompany) {
        const responseTimeMs = Date.now() - requestStartTime;
        const requestRecord: EnrichmentRequestRecord = {
          hs_company_id: companyId || `api_${requestId}`,
          domain: normalizedDomain,
          company_id: savedCompany.id,
          request_source: companyId ? 'hubspot' : 'api',
          request_type: requestType,
          was_cached: false,
          cost_usd: result.cost.total.costUsd,
          response_time_ms: responseTimeMs,
          raw_api_responses: result.raw_api_responses || null,
          enrichment_cost: result.cost || null,
        };
        await saveEnrichmentRequest(requestRecord, supabase);
      }

      return result;
    };

    // If async mode, return immediately and process in background
    if (async === true || async === 'true') {
      waitUntil(doEnrichment().catch(async (err) => {
        console.error('Background enrichment error:', err);
        // Log the error to enrichment_requests
        const responseTimeMs = Date.now() - requestStartTime;
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        const errorType = err?.type || (err?.statusCode === 429 ? 'rate_limit' : 'error');
        await supabase.from('enrichment_requests').insert({
          hs_company_id: companyId || `api_${requestId}`,
          domain: normalizedDomain,
          request_source: companyId ? 'hubspot' : 'api',
          request_type: 'error',
          status: errorType,
          error_message: errorMessage,
          was_cached: false,
          cost_usd: 0,
          response_time_ms: responseTimeMs,
        });
      }));
      
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
  } catch (error: unknown) {
    console.error('Enrichment error:', error);
    
    // Log the error to enrichment_requests
    const responseTimeMs = Date.now() - requestStartTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const err = error as { type?: string; statusCode?: number };
    const errorType = err?.type || (err?.statusCode === 429 ? 'rate_limit' : 'error');
    
    await supabase.from('enrichment_requests').insert({
      hs_company_id: companyId || `api_${requestId}`,
      domain: normalizedDomain,
      request_source: companyId ? 'hubspot' : 'api',
      request_type: 'error',
      status: errorType,
      error_message: errorMessage,
      was_cached: false,
      cost_usd: 0,
      response_time_ms: responseTimeMs,
    });
    
    return res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
}

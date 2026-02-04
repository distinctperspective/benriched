import { supabase as defaultSupabase } from './supabase.js';
import { SupabaseClient } from '@supabase/supabase-js';

export interface RawApiResponses {
  domainResolution?: {
    submitted_domain: string;
    resolved_domain: string;
    domain_changed: boolean;
    resolution_method: string;
  };
  pass1?: string;
  pass2?: string;
  deepResearch?: string;
  zoominfo?: any;
}

export interface EnrichmentCost {
  ai?: {
    pass1?: { model: string; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
    pass2?: { model: string; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
    deepResearch?: { model: string; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
    total?: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
  };
  firecrawl?: { scrapeCount: number; creditsUsed: number; costUsd: number };
  total?: { costUsd: number };
}

export interface EnrichmentRequestRecord {
  id?: string;
  hs_company_id: string;
  domain: string;
  company_id?: string | null;
  user_id?: string | null;
  request_source?: string;
  request_type?: string;
  was_cached: boolean;
  cost_usd?: number | null;
  response_time_ms?: number | null;
  raw_api_responses?: RawApiResponses | null;
  enrichment_cost?: EnrichmentCost | null;
  created_at?: string;
}

export async function saveEnrichmentRequest(
  request: EnrichmentRequestRecord,
  supabaseClient?: SupabaseClient
): Promise<{ data: EnrichmentRequestRecord | null; error: any }> {
  const supabase = supabaseClient || defaultSupabase;
  const { data, error } = await supabase
    .from('enrichment_requests')
    .insert(request)
    .select()
    .single();

  return { data, error };
}

export async function getEnrichmentRequestByHsCompany(hsCompanyId: string, domain: string): Promise<{ data: EnrichmentRequestRecord | null; error: any }> {
  const { data, error } = await supabase
    .from('enrichment_requests')
    .select('*')
    .eq('hs_company_id', hsCompanyId)
    .eq('domain', domain)
    .single();
  
  return { data, error };
}

import { supabase } from './supabase.js';

export interface RawApiResponses {
  pass1?: string;
  pass2?: string;
  deepResearch?: string;
}

export interface EnrichmentRequestRecord {
  id?: string;
  hs_company_id: string;
  domain: string;
  company_id?: string | null;
  request_source?: string;
  was_cached: boolean;
  cost_usd?: number | null;
  response_time_ms?: number | null;
  raw_api_responses?: RawApiResponses | null;
  created_at?: string;
}

export async function saveEnrichmentRequest(request: EnrichmentRequestRecord): Promise<{ data: EnrichmentRequestRecord | null; error: any }> {
  const { data, error } = await supabase
    .from('enrichment_requests')
    .upsert(request, { onConflict: 'hs_company_id' })
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

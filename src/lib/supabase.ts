import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface CompanyRecord {
  id?: string;
  domain: string;
  company_name: string | null;
  website: string | null;
  linkedin_url: string | null;
  business_description: string | null;
  company_size: string | null;
  company_revenue: string | null;
  city: string | null;
  state: string | null;
  hq_country: string | null;
  is_us_hq: boolean;
  is_us_subsidiary: boolean;
  naics_codes_6_digit: Array<{ code: string; description: string }>;
  naics_codes_csv: string | null;
  target_icp: boolean;
  target_icp_matches: Array<{ code: string; description: string }>;
  source_urls: string[];
  quality: Record<string, any>;
  enrichment_cost: Record<string, any>;
  performance_metrics: Record<string, any>;
  created_at?: string;
  updated_at?: string;
  last_enriched_at?: string;
}

export async function saveCompany(company: CompanyRecord): Promise<{ data: CompanyRecord | null; error: any }> {
  const { data, error } = await supabase
    .from('companies')
    .upsert(company, { onConflict: 'domain' })
    .select()
    .single();
  
  return { data, error };
}

export async function getCompanyByDomain(domain: string): Promise<{ data: CompanyRecord | null; error: any }> {
  const { data, error } = await supabase
    .from('companies')
    .select('*')
    .eq('domain', domain)
    .single();
  
  return { data, error };
}

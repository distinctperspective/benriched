import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
// Use service role key for backend operations to bypass RLS
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseServiceKey);

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
  target_icp?: boolean; // Optional - calculated by database trigger
  target_icp_matches: Array<{ code: string; description: string }>;
  source_urls: string[];
  quality: Record<string, any>;
  performance_metrics: Record<string, any>;
  // Parent company linking
  parent_company_id?: string | null;
  parent_company_name?: string | null;
  parent_company_domain?: string | null;
  parent_company_revenue?: string | null;
  inherited_revenue?: boolean;
  inherited_size?: boolean;
  created_at?: string;
  updated_at?: string;
  last_enriched_at?: string;
}

export async function saveCompany(company: CompanyRecord): Promise<{ data: CompanyRecord | null; error: any }> {
  // Check if existing record has inherited data that should be preserved
  const { data: existing } = await supabase
    .from('companies')
    .select('parent_company_id, parent_company_name, parent_company_domain, inherited_revenue, inherited_size, company_revenue, company_size')
    .eq('domain', company.domain)
    .single();
  
  // If existing record has inherited revenue and new data doesn't have parent info,
  // preserve the inherited revenue from the parent
  if (existing?.inherited_revenue && existing?.parent_company_name) {
    // Check if new enrichment found worse revenue than inherited
    const newRevenue = company.company_revenue;
    const existingRevenue = existing.company_revenue;
    
    // Revenue bands in order (for comparison)
    const revenueBandOrder = ['0-500K', '500K-1M', '1M-5M', '5M-10M', '10M-25M', '25M-75M', '75M-200M', '200M-500M', '500M-1B', '1B-10B', '10B-100B', '100B-1T'];
    const newIndex = revenueBandOrder.indexOf(newRevenue || '');
    const existingIndex = revenueBandOrder.indexOf(existingRevenue || '');
    
    // If new revenue is worse (lower band) than existing inherited, keep the inherited
    if (existingIndex > newIndex) {
      company.company_revenue = existingRevenue;
      company.inherited_revenue = true;
    }
    
    // Always preserve parent company info
    company.parent_company_id = existing.parent_company_id;
    company.parent_company_name = existing.parent_company_name;
    company.parent_company_domain = existing.parent_company_domain;
  }
  
  // Same for inherited size
  if (existing?.inherited_size && existing?.parent_company_name) {
    const sizeBandOrder = ['0-1 Employees', '2-10 Employees', '11-50 Employees', '51-200 Employees', '201-500 Employees', '501-1,000 Employees', '1,001-5,000 Employees', '5,001-10,000 Employees', '10,001+ Employees'];
    const newSizeIndex = sizeBandOrder.indexOf(company.company_size || '');
    const existingSizeIndex = sizeBandOrder.indexOf(existing.company_size || '');
    
    if (existingSizeIndex > newSizeIndex) {
      company.company_size = existing.company_size;
      company.inherited_size = true;
    }
  }
  
  const { data, error } = await supabase
    .from('companies')
    .upsert(company, { onConflict: 'domain' })
    .select()
    .single();
  
  return { data, error };
}

export async function getCompanyByDomain(domain: string): Promise<{ data: CompanyRecord | null; error: any }> {
  // Normalize domain - strip www. prefix if present
  const normalizedDomain = domain.replace(/^www\./, '');
  
  // Try normalized domain first
  const { data, error } = await supabase
    .from('companies')
    .select('*')
    .eq('domain', normalizedDomain)
    .single();
  
  // If not found and original had www., also try with www. prefix
  if (!data && domain.startsWith('www.')) {
    const { data: wwwData, error: wwwError } = await supabase
      .from('companies')
      .select('*')
      .eq('domain', domain)
      .single();
    
    if (wwwData) {
      return { data: wwwData, error: wwwError };
    }
  }
  
  // If not found and original didn't have www., try with www. prefix
  if (!data && !domain.startsWith('www.')) {
    const { data: wwwData, error: wwwError } = await supabase
      .from('companies')
      .select('*')
      .eq('domain', `www.${domain}`)
      .single();
    
    if (wwwData) {
      return { data: wwwData, error: wwwError };
    }
  }
  
  return { data, error };
}

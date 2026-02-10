// Hono app environment type for typed context variables
export type AppEnv = {
  Variables: {
    apiKey: string;
    userId: string | null;
  };
};

export type EntityScope = 'operating_company' | 'ultimate_parent';
export type RelationshipType = 'standalone' | 'subsidiary' | 'division' | 'brand' | 'unknown';
export type SourceType = 'filing' | 'company_ir' | 'company_site' | 'reputable_media' | 'estimate_site' | 'directory' | 'unknown';

export interface RevenueEvidence {
  amount: string;
  source: string;
  year: string;
  is_estimate: boolean;
  scope?: EntityScope;
  source_type?: SourceType;
  evidence_url?: string;
  evidence_excerpt?: string;
}

export interface EmployeeEvidence {
  amount: string;
  source: string;
  scope?: EntityScope;
  source_type?: SourceType;
  evidence_url?: string;
}

export interface Pass1Result {
  company_name: string;
  parent_company?: string | null;
  entity_scope?: EntityScope;
  relationship_type?: RelationshipType;
  scope_used_for_numbers?: EntityScope;
  headquarters?: {
    city?: string;
    state?: string;
    country?: string;
    country_code?: string;
  } | null;
  urls_to_crawl: string[];
  search_queries?: string[];
  revenue_found?: RevenueEvidence[] | null;
  employee_count_found?: EmployeeEvidence | null;
  linkedin_url_candidates?: Array<{url: string; confidence: 'high' | 'medium' | 'low'}>;
  canonical_website?: {
    url: string;
    confidence: 'high' | 'medium' | 'low';
    reasoning: string;
  };
}

export interface NAICSCode {
  code: string;
  description: string;
}

export interface FieldQuality {
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export interface QualityMetrics {
  location: FieldQuality;
  revenue: FieldQuality;
  size: FieldQuality;
  industry: FieldQuality;
}

export interface TargetICPMatch {
  code: string;
  description: string;
}

export interface FieldSource {
  url: string;
  source_type: SourceType;
  excerpt?: string;
  scope?: EntityScope;
  year?: string;
}

export interface FieldSources {
  revenue?: FieldSource[];
  employees?: FieldSource[];
  hq?: FieldSource[];
  linkedin?: FieldSource[];
  naics?: FieldSource[];
}

export interface DiagnosticInfo {
  revenue_sources_found: RevenueEvidence[];
  employee_sources_found: { amount: string; source: string } | null;
  revenue_adjustment?: {
    original_band: string | null;
    adjusted_band: string | null;
    reason: string;
  };
  deep_research?: {
    triggered: boolean;
    forced: boolean;
    reasons: string[];
    revenue_found?: string | null;
    employees_found?: number | null;
    location_found?: string | null;
  };
  field_sources?: FieldSources;
  domain_verification?: {
    input_domain: string;
    final_domain: string;
    domain_changed: boolean;
    verification_source: 'pass1_canonical' | 'domain_resolver' | 'input';
    confidence: 'high' | 'medium' | 'low' | null;
    reasoning: string | null;
  };
}

export interface EnrichmentResult {
  company_name: string;
  website: string;
  domain: string;
  linkedin_url: string | null;
  business_description: string;
  company_size: string;
  company_revenue: string | null;
  naics_codes_6_digit: NAICSCode[];
  naics_codes_csv: string;
  city: string;
  state: string | null;
  hq_country: string;
  is_us_hq: boolean;
  is_us_subsidiary: boolean;
  source_urls: string[];
  quality: QualityMetrics;
  target_icp?: boolean; // Optional - calculated by database trigger
  target_icp_matches: TargetICPMatch[];
  revenue_pass: boolean;
  industry_pass: boolean;
  diagnostics?: DiagnosticInfo;
  // Parent company linking
  parent_company_name?: string | null;
  parent_company_domain?: string | null;
  parent_company_revenue?: string | null;
  inherited_revenue?: boolean;
  inherited_size?: boolean;
}

export interface LinkedInValidation {
  isValid: boolean;
  reason?: string;
  linkedinEmployees?: string;
  linkedinWebsite?: string;
  linkedinLocation?: string;
}

export interface AIUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface FirecrawlUsage {
  scrapeCount: number;
  creditsUsed: number;
  costUsd: number;
}

export interface CostBreakdown {
  ai: {
    pass1: AIUsage;
    pass2: AIUsage;
    deepResearch?: AIUsage;
    total: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      costUsd: number;
    };
  };
  firecrawl: FirecrawlUsage;
  total: {
    costUsd: number;
  };
}

export interface PerformanceMetrics {
  pass1_ms: number;
  scraping_ms: number;
  pass2_ms: number;
  total_ms: number;
  scrape_count: number;
  avg_scrape_ms: number;
}

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
}

export interface EnrichmentResultWithCost extends EnrichmentResult {
  cost: CostBreakdown;
  performance: PerformanceMetrics;
  raw_api_responses?: RawApiResponses;
}

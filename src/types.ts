export interface RevenueEvidence {
  amount: string;
  source: string;
  year: string;
  is_estimate: boolean;
}

export interface Pass1Result {
  company_name: string;
  parent_company?: string | null;
  headquarters?: {
    city?: string;
    state?: string;
    country?: string;
    country_code?: string;
  } | null;
  urls_to_crawl: string[];
  search_queries?: string[];
  revenue_found?: RevenueEvidence[] | null;
  employee_count_found?: {
    amount: string;
    source: string;
  } | null;
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
  target_icp: boolean;
  target_icp_matches: TargetICPMatch[];
  revenue_pass: boolean;
  diagnostics?: DiagnosticInfo;
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

export interface EnrichmentResultWithCost extends EnrichmentResult {
  cost: CostBreakdown;
  performance: PerformanceMetrics;
}

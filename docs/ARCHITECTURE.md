# Benriched System Architecture

## Overview

The Benriched enrichment system is a sophisticated multi-stage pipeline that combines web search, intelligent scraping, and AI analysis to extract and validate company data. It uses a dual-AI approach (Perplexity for web search, GPT-4o-mini for analysis) with automatic outlier detection and parent company data inheritance.

**Key Characteristics:**
- Multi-stage data collection and validation pipeline
- Cost-optimized web scraping with intelligent URL prioritization
- Dual LLM approach: Perplexity (web search) + GPT-4o-mini (content analysis)
- Automatic deep research triggers for data conflicts
- Parent company inheritance for incomplete subsidiary data
- Comprehensive quality metrics and diagnostic tracking

---

## Table of Contents

1. [High-Level Architecture](#high-level-architecture)
2. [Company Enrichment Pipeline (12 Stages)](#company-enrichment-pipeline-12-stages)
3. [Contact Enrichment Workflow](#contact-enrichment-workflow)
4. [Cost Tracking & Optimization](#cost-tracking--optimization)
5. [Quality Assurance Mechanisms](#quality-assurance-mechanisms)
6. [External Integrations](#external-integrations)
7. [Performance Characteristics](#performance-characteristics)

---

## High-Level Architecture

### System Overview Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    API REQUEST ENTRY POINT                      │
│              POST /v1/enrich or POST /v1/enrich/contact          │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
        ┌────────────────────────────────────┐
        │  Check Database Cache              │
        │  (if not force_refresh)            │
        └────────────────────┬───────────────┘
                             │
                    ┌────────┴────────┐
                    │                 │
              YES   ▼                 ▼   NO
          ┌──────────────┐    ┌──────────────────────┐
          │ Return       │    │ Start Enrichment     │
          │ Cached Data  │    │ Pipeline             │
          └──────────────┘    └──────────────────────┘
                                     │
                                     ▼
                    ┌────────────────────────────────┐
                    │ ENRICHMENT PIPELINE             │
                    │ (12 Stages - See below)        │
                    └────────────────────────────────┘
                                     │
                                     ▼
                    ┌────────────────────────────────┐
                    │ Save to Database                │
                    │ Track Request Metrics           │
                    └────────────────────────────────┘
                                     │
                                     ▼
                    ┌────────────────────────────────┐
                    │ Return Results + Cost Breakdown │
                    └────────────────────────────────┘
```

### Key Design Decisions

1. **Two-Pass AI Architecture**
   - Pass 1 (Perplexity): Web search for raw data discovery
   - Pass 2 (GPT-4o-mini): Content analysis and structured extraction
   - Rationale: Perplexity excels at web search; GPT excels at analysis

2. **Smart URL Selection**
   - Don't scrape everything (expensive)
   - Intelligently select based on what Pass 1 already found
   - Tier-based categorization reduces unnecessary scraping

3. **Deep Research Trigger**
   - Automatically detect outliers and conflicts
   - Run focused searches only when needed
   - Saves cost by avoiding unnecessary deep dives

4. **Entity Mismatch Detection**
   - Prevent enriching wrong company
   - Re-run in strict mode if mismatch detected
   - Preserve original evidence when possible

5. **Parent Company Inheritance**
   - Brands often have no independent data
   - Inherit from parent when child is weak
   - Enables ICP matching for subsidiaries

6. **Cache-First Approach**
   - Check database before any API calls
   - Avoid re-enriching same domain
   - `force_refresh` parameter for updates

7. **Transparent Cost Tracking**
   - Track every API call and credit usage
   - Transparent cost breakdown in response
   - Enable cost optimization decisions

---

## Company Enrichment Pipeline (12 Stages)

### Stage 0: Domain Normalization & Cache Check

**Purpose:** Prepare the domain input and check for cached data.

**Process:**
1. Normalize Domain
   - Strip `https://`, `http://`, `www.` prefixes
   - Remove trailing slashes
   - Example: `https://www.example.com/` → `example.com`

2. Cache Lookup (unless `force_refresh=true`)
   - Query database for existing company record by domain
   - If found: Return cached data immediately
   - Track request as "cached" type with 0 cost
   - Response time is typically <10ms

3. If Not Cached: Proceed to enrichment pipeline

---

### Stage 1: Domain Resolution

**Purpose:** Handle cases where the domain is dead, email-only, or doesn't have a live website.

**Process:**
1. Check if domain has a valid website
2. If domain is dead/invalid, use Firecrawl to search for the actual company website
3. Return resolved domain for use in subsequent stages
4. Track Firecrawl credits used

**Output:**
```typescript
{
  submitted_domain: string;
  resolved_domain: string;
  domain_changed: boolean;
  resolution_method: string;
  credits_used: number;
}
```

---

### Stage 2: Pass 1 - Web Search (Perplexity Sonar Pro)

**Purpose:** Use web search to identify the company, find key data points, and determine which URLs to scrape.

**Model:** Perplexity Sonar Pro (via AI Gateway)

**Process:**

1. **Company Identification**
   - Search web for company information at domain
   - Identify company name
   - Detect parent company relationships (if subsidiary/brand)
   - Classify entity scope: "operating_company" vs "ultimate_parent"

2. **Data Collection from Web Search**
   - Search for annual revenue figures
   - Search for employee count
   - Identify headquarters location (city, state, country)
   - Find LinkedIn company page candidates
   - Collect evidence URLs and excerpts

3. **URL Categorization**
   - Identify URLs to crawl in subsequent stages
   - Prioritize: company website, LinkedIn, data aggregators
   - Return list of URLs with context

**Output (Pass1Result):**
```typescript
{
  company_name: string;
  parent_company: string | null;
  entity_scope: "operating_company" | "ultimate_parent";
  relationship_type: "standalone" | "subsidiary" | "division" | "brand" | "unknown";
  headquarters: {
    city: string;
    state: string;
    country: string;
    country_code: string;
  };
  urls_to_crawl: string[];
  revenue_found: Array<{
    amount: string;
    source: string;
    year: string;
    is_estimate: boolean;
    scope: "operating_company" | "ultimate_parent";
    source_type: "filing" | "company_ir" | "company_site" | "reputable_media" | "estimate_site" | "directory" | "unknown";
    evidence_url: string;
    evidence_excerpt: string;
  }>;
  employee_count_found: {
    amount: string;
    source: string;
    scope: "operating_company" | "ultimate_parent";
    source_type: string;
    evidence_url: string;
  } | null;
  linkedin_url_candidates: Array<{
    url: string;
    confidence: "high" | "medium" | "low";
  }>;
}
```

---

### Stage 3: Deep Research (Conditional)

**Purpose:** Conduct targeted research when Pass 1 results have outliers or missing data.

**Trigger Conditions:**

Deep research is automatically triggered if Pass 1 results have outliers:
1. **Missing Revenue** - No revenue figures found
2. **Missing Employees** - No employee count found
3. **Missing Location** - No headquarters location found
4. **Revenue/Size Mismatch** - Revenue > $100M but employees < 50 (suspicious)
5. **Source Conflicts** - Revenue figures differ by >5x (conflicting sources)
6. **Public Company** - Detected as publicly traded (needs SEC data)

Can also be forced via `forceDeepResearch` parameter.

**Process:**
1. Run focused web searches for missing/conflicting data
2. Attempt to resolve outliers with targeted queries
3. Return additional evidence for revenue, employees, location

**Output (DeepResearchResult):**
```typescript
{
  revenue: {
    amount: string | null;
    source: string | null;
    year: string | null;
    confidence: "high" | "medium" | "low";
  } | null;
  employees: {
    count: number | null;
    source: string | null;
    confidence: "high" | "medium" | "low";
  } | null;
  location: {
    city: string | null;
    state: string | null;
    country: string | null;
    is_us_hq: boolean;
    is_us_subsidiary: boolean;
  } | null;
  triggered_by: string[];
  usage: AIUsage;
}
```

**Merge Strategy:**
- Deep research results are merged into Pass 1 results
- Prioritizes deep research findings for conflicting data
- Preserves original data if deep research has no new findings

---

### Stage 4: Smart URL Categorization & Scraping

**Purpose:** Intelligently select which URLs to scrape based on what data Pass 1 already found.

**URL Tiers:**

1. **Tier 1 (Essential)** - Always scraped
   - Company website (domain itself)
   - LinkedIn company page
   - Official investor relations site

2. **Tier 2 (Data Aggregators)** - Conditionally scraped
   - Crunchbase
   - ZoomInfo
   - Apollo
   - Hunter.io
   - LinkedIn (if not already in Tier 1)

3. **Tier 3 (Low Value)** - Never scraped
   - Wikipedia
   - Glassdoor
   - Indeed
   - News articles

**Smart Selection Logic:**

```
IF Pass 1 found both revenue AND employees:
  → Scrape only Tier 1 (company site + LinkedIn)
  → Skip Tier 2 (already have good data)

ELSE IF Pass 1 found revenue OR employees (but not both):
  → Scrape Tier 1 + 2 data aggregators (up to 2)
  → Need to fill in missing data

ELSE (missing both revenue and employees):
  → Scrape Tier 1 + 4 data aggregators (up to 4)
  → Need comprehensive data coverage
```

**Scraping Tool:** Firecrawl API
- Converts web pages to clean markdown
- Tracks credits used per page
- Returns structured content

---

### Stage 5: Entity Mismatch Detection

**Purpose:** Detect if Pass 1 identified the wrong company.

**Signals Checked:**
1. Company name from Pass 1 not found in scraped website content
2. Domain name IS found in content (suggests different company)
3. Conflicting business descriptions

**If Mismatch Detected:**
1. Re-run Pass 1 in "strict mode" (more conservative)
2. Merge results from both passes
3. Re-scrape URLs with corrected company information
4. Preserve original revenue/employee data (often more reliable)

---

### Stage 6: LinkedIn Extraction & Validation

**Purpose:** Extract and validate the company's LinkedIn profile URL.

**Priority Order:**

1. **Company Website** (Most Authoritative)
   - Search scraped company website for LinkedIn link
   - If found, use immediately (no validation needed)
   - This is the official company-provided link

2. **Pass 1 Results** (Needs Validation)
   - Use LinkedIn URL from Perplexity search
   - Validate against expected data:
     - Employee count match
     - Location match
     - Business description match
   - Reject if validation fails (likely wrong company)

3. **Fallback: Search Scraped Content**
   - Look for employee count patterns in data aggregators
   - Extract from Crunchbase, ZoomInfo, etc.

**Validation Process:**
- Scrape LinkedIn page
- Compare employee count with Pass 1 expectations
- Compare location with Pass 1 headquarters
- Verify company name matches
- Reject if >20% mismatch

---

### Stage 7: Pass 2 - Content Analysis (GPT-4o-mini)

**Purpose:** Analyze all scraped content to extract structured company data.

**Model:** OpenAI GPT-4o-mini (via AI Gateway)

**Input:**
- Scraped content from all selected URLs
- Pass 1 results (for context)
- Company name and domain

**Key Responsibilities:**
1. Extract business description (2-4 sentences, identify PRIMARY business activity)
2. Determine HQ location (city, state, country)
3. Identify if US HQ or US subsidiary
4. Extract/validate LinkedIn URL
5. Determine revenue band (from 12 predefined bands)
6. Determine employee band (from 9 predefined bands)
7. Select 2-3 NAICS codes (6-digit)
8. Provide quality metrics for each field

**Revenue Priority Hierarchy:**
1. SEC filings / audited financials (highest authority)
2. Investor relations / earnings releases
3. Company press releases
4. Reputable media (Forbes, Bloomberg, Reuters, WSJ)
5. Wikipedia (as pointer only)
6. Directory/estimate sites (Growjo, Owler, Zippia, ZoomInfo) (lowest)

**Business Description Rules:**
- Identify PRIMARY business activity (what they DO):
  - Manufacturer: "manufacturer of [products]"
  - Retailer: "retailer of [products]" or "operates [type] stores"
  - Wholesaler/Distributor: "wholesaler of [products]" or "distributor of [products]"
  - Food Service: "operates [type] restaurants" or "provides [type] food service"
- Use "serving" or "targeting" for customer markets
- Include specific products/services, target markets, key differentiators

**Output (EnrichmentResult):**
```typescript
{
  business_description: string;
  city: string;
  state: string | null;
  hq_country: string;
  is_us_hq: boolean;
  is_us_subsidiary: boolean;
  linkedin_url: string | null;
  company_revenue: string | null;
  company_size: string | null;
  naics_codes_6_digit: NAICSCode[];
  source_urls: string[];
  quality: {
    location: { confidence: "high" | "medium" | "low"; reasoning: string };
    revenue: { confidence: "high" | "medium" | "low"; reasoning: string };
    size: { confidence: "high" | "medium" | "low"; reasoning: string };
    industry: { confidence: "high" | "medium" | "low"; reasoning: string };
  };
}
```

---

### Stage 8: Revenue & Size Estimation

**Purpose:** Fill in missing revenue or employee data using intelligent estimation.

**Estimation Hierarchy:**

1. **Pass 1 Evidence** (Highest Priority)
   - Use actual revenue figures found via web search
   - Pick best evidence from multiple sources
   - Confidence: High

2. **Pass 2 Findings** (Second Priority)
   - Use data extracted from scraped content
   - Confidence: Medium

3. **Revenue ↔ Size Correlation** (Third Priority)
   - If have revenue but no employees: estimate employees from revenue + industry
   - If have employees but no revenue: estimate revenue from employees + industry
   - Confidence: Medium

4. **Industry Averages** (Last Resort)
   - Use NAICS code to find industry average revenue/size
   - Only used if no other data available
   - Confidence: Low

**Sanity Checks:**
- Validate revenue vs employee count consistency
- Flag suspicious combinations (e.g., $1B revenue with 5 employees)
- Adjust if mismatch detected

---

### Stage 9: Parent Company Enrichment

**Purpose:** Inherit data from parent company if child company has weak data.

**Trigger Conditions:**

Child company is considered "weak" if:
- No revenue data found, OR
- Revenue is below $10M threshold, OR
- Company size is 0-50 employees

**Process:**

1. **Parent Company Detection**
   - Pass 1 identifies parent company name
   - Example: "Coca-Cola" is parent of "Sprite"

2. **Parent Domain Guessing**
   - Use known mapping of parent company names to domains
   - Example: "General Mills" → "generalmills.com"
   - Fallback: Generate domain from company name

3. **Parent Lookup in Database**
   - Check if parent company already enriched in database
   - If found and has good data: inherit revenue/size

4. **Data Inheritance**
   - Inherit revenue if child has no passing revenue
   - Inherit employee size if child has small/unknown size
   - Mark as "inherited_revenue" and "inherited_size" flags
   - Preserve parent company name and domain

5. **ICP Recalculation**
   - Recalculate target_icp with inherited data
   - May now pass ICP criteria with parent's revenue

**Known Parent Mappings:**
- General Mills, Nestlé, Kraft Heinz, PepsiCo, Coca-Cola, Unilever, etc.
- ~50+ major food & beverage companies mapped
- Extensible for other industries

---

### Stage 10: Final Data Assembly & Cost Calculation

**Purpose:** Calculate costs, compile performance metrics, and assemble final response.

**Process:**

1. **Cost Breakdown Calculation**
   ```
   Total Cost = AI Cost + Firecrawl Cost

   AI Cost = Pass 1 + Pass 2 + Deep Research (if triggered)

   Firecrawl Cost = (Credits Used / 1000) * $0.10
   ```

2. **Performance Metrics**
   - Pass 1 execution time (ms)
   - Scraping execution time (ms)
   - Pass 2 execution time (ms)
   - Total execution time (ms)
   - Average time per page scraped

3. **Raw API Responses**
   - Store domain resolution details
   - Store Pass 1 raw response
   - Store Pass 2 raw response
   - Store Deep Research raw response (if triggered)

4. **Final Result Assembly**
   ```typescript
   {
     ...enrichmentResult,
     cost: CostBreakdown,
     performance: PerformanceMetrics,
     raw_api_responses: RawApiResponses
   }
   ```

---

### Stage 11: Database Storage

**Purpose:** Save enriched data to database for caching and analytics.

**Process:**

1. **companies table**
   - Stores enriched company data
   - Indexed by domain (primary key)
   - Includes all extracted fields
   - Tracks last_enriched_at timestamp

2. **enrichment_requests table**
   - Logs all enrichment requests
   - Tracks cost, response time, cache status
   - Stores raw API responses for debugging
   - Indexed by hs_company_id and domain

**Upsert Logic:**
- If company exists: update with new data
- Preserve inherited revenue/size if new data is worse
- Maintain parent company relationships

---

## Contact Enrichment Workflow

### Entry Point: `POST /v1/enrich/contact`

**Request Body:**
```json
{
  "email": "john@example.com",
  "full_name": "John Doe",
  "first_name": "John",
  "last_name": "Doe",
  "job_title": "CEO",
  "company_name": "Example Inc",
  "hs_company_id": "optional_hubspot_company_id",
  "hs_contact_id": "optional_hubspot_contact_id"
}
```

### Workflow:

1. **Cache Check**
   - Query database for existing contact by email
   - If found: return cached data immediately
   - Response time: <10ms

2. **ZoomInfo Authentication**
   - Check for cached JWT token (valid for 24 hours)
   - If expired: authenticate with ZoomInfo API
   - Cache token for 23.5 hours (refresh 30min early)

3. **ZoomInfo Enrichment API Call**
   - Build request with email and optional fields
   - Send to ZoomInfo Enrich API
   - Receive enriched contact data

4. **Response Processing**
   - Check match status (MATCH, CONFIDENT_MATCH, FULL_MATCH)
   - Extract contact data fields:
     - First name, last name
     - Phone, mobile phone, direct phone
     - Job title, management level
     - Company name, company website
     - City, state, country
     - LinkedIn URL (from externalUrls array)

5. **Database Storage**
   - Upsert contact record by email or HubSpot ID
   - Store enriched data
   - Link to company if hs_company_id provided

6. **Response**
   ```json
   {
     "success": true,
     "data": {
       "email_address": "john@example.com",
       "first_name": "John",
       "last_name": "Doe",
       "job_title": "CEO",
       "direct_phone": "+1-555-0123",
       "cell_phone": "+1-555-0456",
       "linked_profile_url": "https://linkedin.com/in/johndoe"
     },
     "was_cached": false,
     "credits_used": 1,
     "response_time_ms": 1234
   }
   ```

---

## Cost Tracking & Optimization

### Cost Components

**1. AI Costs (via AI Gateway)**

Pass 1 (Perplexity Sonar Pro):
- Input tokens: ~500-1000 per request
- Output tokens: ~1000-2000 per request
- Cost: ~$0.01-0.03 per request

Pass 2 (OpenAI GPT-4o-mini):
- Input tokens: ~2000-5000 (includes scraped content)
- Output tokens: ~500-1000 per request
- Cost: ~$0.01-0.02 per request

Deep Research (Perplexity, if triggered):
- Input tokens: ~500-1000 per query
- Output tokens: ~500-1000 per query
- Cost: ~$0.01-0.02 per query
- Typically 1-3 queries if triggered

**2. Firecrawl Costs**

- Base rate: $0.10 per 1000 credits
- Typical page scrape: 1-5 credits per page
- Typical enrichment: 5-20 pages scraped
- Cost per enrichment: ~$0.01-0.20

**3. Total Cost Estimate**

Typical enrichment: **$0.03-0.08 per company**
- Cached hit: $0.00
- With deep research: +$0.01-0.02
- With heavy scraping: +$0.05-0.10

### Cost Optimization Strategies

1. **Caching**
   - Database cache check before any API calls
   - `force_refresh` parameter to bypass cache
   - Tracks cached vs. fresh requests

2. **Smart Scraping**
   - Conditional Tier 2 scraping based on Pass 1 results
   - Skips Tier 3 entirely (low value)
   - Reduces Firecrawl credits by 50-70%

3. **Deep Research Triggers**
   - Only runs when outliers detected
   - Parallel queries to minimize token usage
   - Saves ~$0.02-0.05 per enrichment when not needed

---

## Quality Assurance Mechanisms

### Entity Mismatch Detection
- Checks if Pass 1 company name appears in scraped content
- If mismatch detected, re-runs Pass 1 in strict mode
- Merges revenue evidence from both passes

### LinkedIn Validation
- Validates LinkedIn URL against expected employees/location
- Rejects if validation fails (likely wrong company)
- Only validates URLs from Pass 1 (website links are authoritative)

### Revenue Validation
- Validates revenue vs. employee count consistency
- Applies industry-specific ratios
- Adjusts revenue band if mismatch detected

### Quality Metrics
- Confidence levels (high/medium/low) for each field
- Reasoning for each data point
- Source tracking for all extracted data

---

## External Integrations

### Perplexity Sonar Pro
- Model: `perplexity/sonar-pro`
- Used in: Pass 1, Deep Research
- Cost: ~$0.003 per 1K input tokens, ~$0.01 per 1K output tokens
- Purpose: Web search with real-time internet access

### OpenAI GPT-4o-mini
- Model: `openai/gpt-4o-mini`
- Used in: Pass 2
- Cost: ~$0.00015 per 1K input tokens, ~$0.0006 per 1K output tokens
- Purpose: Content analysis and data extraction

### Firecrawl
- Purpose: Extract text content from websites
- Features: Handles JavaScript-rendered content, extracts clean text
- Cost Model: $0.10 per 1000 credits

### ZoomInfo
- Used in: `/enrich/contact` endpoint
- Credentials: ZI_USERNAME, ZI_PASSWORD, ZI_AUTH_URL, ZI_ENRICH_URL
- Returns: Contact details, company info, job title validation

---

## Performance Characteristics

### Typical Execution Times

| Stage | Time (ms) | Notes |
|-------|-----------|-------|
| Domain Resolution | 500-1000 | Only if domain dead |
| Pass 1 (Web Search) | 1000-2000 | Perplexity API call |
| Deep Research | 1000-3000 | Only if triggered |
| URL Scraping | 2000-5000 | Depends on # of pages |
| Pass 2 (Analysis) | 2000-4000 | GPT-4o-mini API call |
| Database Save | 100-500 | Supabase upsert |
| **Total** | **7000-15000** | ~7-15 seconds typical |

### Cached Hit Performance
- Database lookup: ~10-50ms
- Response: <100ms total

### Cost Efficiency
- Cached hit: $0.00
- Fresh enrichment: $0.03-0.08
- With deep research: +$0.01-0.02
- Break-even: ~50 requests before cache pays for itself

---

## Data Flow Diagram

```
INPUT: domain
  ↓
[Stage 0] Normalize & Cache Check
  ├─ Return cached? → RESPONSE
  └─ Continue? ↓
[Stage 1] Domain Resolution
  ├─ Firecrawl search if domain dead
  └─ resolved_domain ↓
[Stage 2] Pass 1: Web Search
  ├─ Perplexity: company name, revenue, employees, HQ, URLs
  └─ Pass1Result ↓
[Stage 3] Deep Research (if outliers detected)
  ├─ Perplexity: focused searches for missing/conflicting data
  └─ Merge into Pass1Result ↓
[Stage 4] URL Categorization & Smart Selection
  ├─ Tier 1: Always (company site, LinkedIn)
  ├─ Tier 2: Conditional (data aggregators)
  └─ Tier 3: Never (Wikipedia, Glassdoor) ↓
[Stage 5] Firecrawl Scraping
  ├─ Scrape selected URLs
  └─ scrapedContent ↓
[Stage 6] Entity Mismatch Detection
  ├─ Company name in content?
  ├─ If no: Re-run Pass 1 strict mode
  └─ Continue ↓
[Stage 7] LinkedIn Extraction & Validation
  ├─ Find LinkedIn on company website (authoritative)
  ├─ Validate LinkedIn from Pass 1 (if needed)
  └─ linkedinUrl ↓
[Stage 8] Pass 2: Content Analysis
  ├─ GPT-4o-mini: business description, location, revenue, size, NAICS, ICP
  └─ EnrichmentResult ↓
[Stage 9] Revenue & Size Estimation
  ├─ Fill missing data using hierarchy
  ├─ Sanity check revenue vs size
  └─ Adjusted result ↓
[Stage 10] Parent Company Enrichment
  ├─ Detect parent company
  ├─ Lookup parent in DB
  ├─ Inherit revenue/size if child weak
  └─ Final result ↓
[Stage 11] Cost Calculation & Assembly
  ├─ Calculate AI + Firecrawl costs
  ├─ Compile performance metrics
  └─ Final result with costs ↓
[Stage 12] Database Storage
  ├─ Upsert companies table
  ├─ Insert enrichment_requests log
  └─ Return response
```

---

## Summary

The Benriched enrichment system is a sophisticated multi-stage pipeline that:

1. **Searches the web** (Pass 1) to identify companies and find initial data
2. **Intelligently scrapes** selected URLs based on what data is already found
3. **Analyzes content** (Pass 2) to extract structured company information
4. **Validates and enriches** data through deep research, entity detection, and parent company inheritance
5. **Tracks costs** transparently for every API call
6. **Caches results** to avoid redundant enrichments
7. **Stores everything** in a database for future reference

The system balances **accuracy** (multiple validation stages), **cost efficiency** (smart URL selection, caching), and **speed** (parallel API calls, intelligent fallbacks).

# Benriched System Architecture

## Overview

The Benriched enrichment system is a multi-stage pipeline that combines web search, intelligent scraping, and AI analysis to extract and validate company data. It uses a dual-AI approach (Perplexity for web search, GPT-4o-mini for analysis) with automatic outlier detection and parent company data inheritance.

**Key Characteristics:**
- Modular pipeline architecture with isolated, testable stages
- Cost-optimized web scraping with intelligent URL prioritization
- Dual LLM approach: Perplexity (web search) + GPT-4o-mini (content analysis)
- Automatic deep research triggers for data conflicts
- Parent company inheritance for incomplete subsidiary data
- Comprehensive quality metrics and diagnostic tracking

---

## Table of Contents

1. [High-Level Architecture](#high-level-architecture)
2. [Pipeline Architecture (Code Structure)](#pipeline-architecture-code-structure)
3. [Company Enrichment Pipeline (12 Stages)](#company-enrichment-pipeline-12-stages)
4. [Contact Enrichment Workflow](#contact-enrichment-workflow)
5. [Cost Tracking & Optimization](#cost-tracking--optimization)
6. [Quality Assurance Mechanisms](#quality-assurance-mechanisms)
7. [External Integrations](#external-integrations)
8. [Performance Characteristics](#performance-characteristics)

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

## Pipeline Architecture (Code Structure)

The enrichment pipeline was modularized in February 2026 to improve debuggability, readability, and testability. What was a single 1,142-line function is now a pipeline of isolated stage files sharing a common context object.

### File Layout

```
src/enrichment/
  enrich.ts                          ← 57 lines: thin wrapper, creates context, calls orchestrator
  deepResearch.ts                    ← unchanged: outlier detection + deep research queries
  scraper.ts → ../scraper.ts         ← unchanged: Firecrawl scraping utilities
  components/                        ← unchanged: reusable building blocks
    pass1.ts                           Perplexity web search
    pass2.ts                           GPT-4o-mini content analysis
    domainResolver.ts                  Domain resolution via Firecrawl
    entityDetection.ts                 Entity mismatch detection
    linkedin.ts                        LinkedIn page validation
    urlCategorization.ts               URL tier classification
    employees.ts                       Employee count → band mapping
    pricing.ts                         AI cost calculation
    icp.ts                             ICP matching constants
    naics.ts                           NAICS code utilities
    prompts.ts                         LLM prompt templates
  pipeline/                          ← NEW: modular pipeline
    context.ts           (151 lines)   Shared state: EnrichmentContext, CostAccumulator, TimingTracker
    orchestrator.ts       (33 lines)   Calls 12 stages in sequence
    parent-domains.ts     (92 lines)   KNOWN_PARENT_DOMAINS map + guessParentDomain()
    stages/
      domain-resolution.ts   (31 lines)  Stage 1: Resolve domain to company website
      pass1-search.ts        (47 lines)  Stage 2: Perplexity web search
      linkedin-search.ts    (164 lines)  Stage 3: Fallback LinkedIn search (Firecrawl + Gemini)
      deep-research.ts       (90 lines)  Stage 4: Conditional deep research
      url-selection.ts       (51 lines)  Stage 5: Smart URL tier selection
      scraping.ts            (33 lines)  Stage 6: Firecrawl multi-page scraping
      entity-validation.ts   (68 lines)  Stage 7: Entity mismatch detection + strict re-run
      linkedin-validation.ts(165 lines)  Stage 8: LinkedIn extraction + validation
      pass2-analysis.ts      (37 lines)  Stage 9: GPT-4o-mini content analysis
      data-estimation.ts    (182 lines)  Stage 10: Revenue/size estimation + sanity checks
      parent-enrichment.ts   (99 lines)  Stage 11: Parent company data inheritance
      final-assembly.ts      (97 lines)  Stage 12: Cost calculation + result assembly
```

### How It Fits Together

```
                        ┌──────────────────────────┐
                        │  Route Handler            │
                        │  (v1/enrich/company.ts)   │
                        └────────────┬─────────────┘
                                     │ calls
                                     ▼
                        ┌──────────────────────────┐
                        │  enrich.ts                │
                        │  enrichDomainWithCost()   │
                        │                          │
                        │  1. createContext(opts)   │
                        │  2. runEnrichmentPipeline │
                        └────────────┬─────────────┘
                                     │ creates & passes
                                     ▼
                  ┌─────────────────────────────────────┐
                  │  EnrichmentContext                   │
                  │                                     │
                  │  Inputs:  domain, models, emitter   │
                  │  State:   pass1Result, pass2Result, │
                  │           scrapedContent, linkedin   │
                  │  Helpers: CostAccumulator,          │
                  │           TimingTracker              │
                  └──────────────────┬──────────────────┘
                                     │ flows through
                                     ▼
                  ┌─────────────────────────────────────┐
                  │  orchestrator.ts                     │
                  │                                     │
                  │  runDomainResolution(ctx)            │
                  │  runPass1Search(ctx)                 │
                  │  runLinkedInSearch(ctx)              │
                  │  runDeepResearchStage(ctx)           │
                  │  urls = runUrlSelection(ctx)         │
                  │  runScraping(ctx, urls)              │
                  │  runEntityValidation(ctx)            │
                  │  runLinkedInValidation(ctx)          │
                  │  runPass2Analysis(ctx)               │
                  │  runDataEstimation(ctx)              │
                  │  runParentEnrichment(ctx)            │
                  │  return runFinalAssembly(ctx)        │
                  └─────────────────────────────────────┘
```

### The EnrichmentContext

Instead of 80+ loose variables scattered through one function, a single shared state object flows through all stages:

```typescript
interface EnrichmentContext {
  // --- Inputs (set once at creation, never modified) ---
  domain: string;                    // Original input domain
  providedCompanyName?: string;      // Optional hint from caller
  providedState?: string;            // Optional hint from caller
  providedCountry?: string;          // Optional hint from caller
  forceDeepResearch: boolean;        // Force deep research pass
  searchModel: any;                  // Perplexity model instance
  analysisModel: any;                // GPT-4o-mini model instance
  searchModelId: string;             // "perplexity/sonar-pro"
  analysisModelId: string;           // "openai/gpt-4o-mini"
  firecrawlApiKey?: string;          // Firecrawl API key
  emitter?: SSEEmitter;              // Optional SSE stream for progress events

  // --- Accumulated state (stages read and write these) ---
  enrichmentDomain: string;          // After domain resolution (may differ from input)
  pass1Result: Pass1Result | null;   // Web search results
  pass1RawResponse: string;          // Raw Perplexity response for debugging
  deepResearchResult: DeepResearchResult | null;
  outlierFlags: OutlierFlags | null; // What triggered deep research
  scrapedContent: Map<string, string>; // URL → markdown content
  scrapeResult: { totalCreditsUsed: number; scrapeCount: number } | null;
  linkedinUrl: string | null;        // Validated LinkedIn URL
  linkedinSource: 'website' | 'pass1' | null;
  linkedinEmployeeCount: string | null;
  pass2Result: EnrichmentResult | null; // GPT analysis result
  pass2RawResponse: string;          // Raw GPT response for debugging
  domainResolution: { ... } | null;  // Domain resolution details

  // --- Cross-cutting concerns ---
  costs: CostAccumulator;            // Tracks AI tokens + Firecrawl credits
  timing: TimingTracker;             // Tracks ms per stage
  rawApiResponses: Record<string, any>;
}
```

### CostAccumulator

Tracks all cost components across stages:

```typescript
class CostAccumulator {
  pass1Usage: AIUsage | null;        // Perplexity tokens + cost
  pass2Usage: AIUsage | null;        // GPT-4o-mini tokens + cost
  deepResearchUsage: AIUsage | null; // Deep research tokens + cost
  firecrawlCredits: number;          // Total Firecrawl credits consumed
  scrapeCount: number;               // Total pages scraped

  addFirecrawlCredits(credits: number): void;
  setScrapeCount(count: number): void;
}
```

### TimingTracker

Tracks execution time per stage:

```typescript
class TimingTracker {
  start(stage: string): void;  // Record start time
  end(stage: string): number;  // Record end time, return duration in ms
  get(stage: string): number;  // Get duration of a completed stage
  get totalMs(): number;       // Time since pipeline started
}
```

### Stage Pattern

Every stage follows the same pattern:

```typescript
// stages/example-stage.ts
import { EnrichmentContext } from '../context.js';

export async function runExampleStage(ctx: EnrichmentContext): Promise<void> {
  // 1. Emit SSE progress event (started)
  await ctx.emitter?.emit({ stage: 'example', message: '...', status: 'started' });

  // 2. Start timing
  ctx.timing.start('example');

  // 3. Do the work (call components, APIs, etc.)
  const result = await someComponent(ctx.enrichmentDomain, ctx.firecrawlApiKey);

  // 4. Write results to context
  ctx.someField = result;
  ctx.costs.addFirecrawlCredits(result.credits);

  // 5. End timing
  ctx.timing.end('example');

  // 6. Emit SSE progress event (complete)
  await ctx.emitter?.emit({ stage: 'example', message: '...', status: 'complete' });
}
```

### Backwards Compatibility

The public API is unchanged. `enrichDomainWithCost()` in `enrich.ts` has the exact same function signature as before:

```typescript
export async function enrichDomainWithCost(
  domain: string,
  searchModel: any,
  analysisModel: any,
  firecrawlApiKey?: string,
  searchModelId?: string,
  analysisModelId?: string,
  forceDeepResearch?: boolean,
  emitter?: SSEEmitter,
  providedCompanyName?: string,
  providedState?: string,
  providedCountry?: string
): Promise<EnrichmentResultWithCost>
```

All callers (`api/index.ts`, `src/routes/v1/enrich/company.ts`, etc.) are untouched. The re-exports for external consumers (`calculateAICost`, `pass1_identifyUrls`, `pass2_analyzeContent`) are preserved.

---

## Company Enrichment Pipeline (12 Stages)

### Data Flow Through Stages

```
ctx.domain ──→ [1 Domain Resolution] ──→ ctx.enrichmentDomain
                                           │
                                           ▼
                                 [2 Pass 1 Search] ──→ ctx.pass1Result
                                           │              (company_name, revenue_found,
                                           │               employee_count, urls_to_crawl,
                                           │               linkedin_candidates, headquarters)
                                           ▼
                                 [3 LinkedIn Search] ──→ ctx.pass1Result.linkedin_url_candidates
                                           │              (enriched if Pass 1 found none)
                                           ▼
                                 [4 Deep Research] ──→ ctx.deepResearchResult
                                           │            (merged into ctx.pass1Result)
                                           ▼
                                 [5 URL Selection] ──→ urlsToScrape[] (local, passed to stage 6)
                                           │
                                           ▼
                                 [6 Scraping] ──→ ctx.scrapedContent (Map<url, markdown>)
                                           │
                                           ▼
                                 [7 Entity Validation] ──→ ctx.pass1Result (may be replaced)
                                           │                ctx.scrapedContent (may be replaced)
                                           ▼
                                 [8 LinkedIn Validation] ──→ ctx.linkedinUrl
                                           │                  ctx.linkedinEmployeeCount
                                           ▼
                                 [9 Pass 2 Analysis] ──→ ctx.pass2Result (the enrichment result)
                                           │
                                           ▼
                                 [10 Data Estimation] ──→ ctx.pass2Result (gaps filled, ICP recalculated)
                                           │
                                           ▼
                                 [11 Parent Enrichment] ──→ ctx.pass2Result (parent data inherited)
                                           │
                                           ▼
                                 [12 Final Assembly] ──→ EnrichmentResultWithCost (returned to caller)
```

---

### Stage 1: Domain Resolution
**File:** `pipeline/stages/domain-resolution.ts` (31 lines)

**Purpose:** Handle cases where the input domain is dead, email-only, or redirects elsewhere.

**Process:**
1. Call `resolveDomainToWebsite()` via Firecrawl search
2. If domain changed, update `ctx.enrichmentDomain`
3. Track Firecrawl credits consumed

**Reads from context:** `ctx.domain`, `ctx.firecrawlApiKey`
**Writes to context:** `ctx.enrichmentDomain`, `ctx.domainResolution`, `ctx.costs`

---

### Stage 2: Pass 1 Search
**File:** `pipeline/stages/pass1-search.ts` (47 lines)

**Purpose:** Use Perplexity Sonar Pro to search the web for company data.

**Process:**
1. Call `pass1_identifyUrlsWithUsage()` with the resolved domain
2. Store the full result (company name, revenue evidence, employee data, URLs, LinkedIn candidates)
3. Log what was found

**Reads from context:** `ctx.enrichmentDomain`, `ctx.searchModel`, `ctx.searchModelId`, `ctx.providedCompanyName/State/Country`
**Writes to context:** `ctx.pass1Result`, `ctx.pass1RawResponse`, `ctx.costs.pass1Usage`

**Output (Pass1Result):**
```typescript
{
  company_name: string;
  parent_company: string | null;
  entity_scope: "operating_company" | "ultimate_parent";
  relationship_type: "standalone" | "subsidiary" | "division" | "brand" | "unknown";
  headquarters: { city, state, country, country_code };
  urls_to_crawl: string[];
  revenue_found: RevenueEvidence[];
  employee_count_found: EmployeeEvidence | null;
  linkedin_url_candidates: Array<{ url: string; confidence: "high" | "medium" | "low" }>;
}
```

---

### Stage 3: LinkedIn Search (Conditional)
**File:** `pipeline/stages/linkedin-search.ts` (164 lines)

**Purpose:** Fallback LinkedIn search when Pass 1 didn't find any LinkedIn candidates.

**Condition:** Only runs if `pass1Result.linkedin_url_candidates` is empty.

**Fallback chain (tries in order until one works):**
1. **Firecrawl Google search** - `"Company Name" site:linkedin.com/company`
2. **Gemini AI search** - Asks Gemini to find the LinkedIn URL
3. **Firecrawl simple search** - `Company Name LinkedIn company page` (no site: filter)

**Ranking:** If multiple LinkedIn pages found, picks the one with the most followers.

**Reads from context:** `ctx.pass1Result`
**Writes to context:** `ctx.pass1Result.linkedin_url_candidates` (adds candidates)

---

### Stage 4: Deep Research (Conditional)
**File:** `pipeline/stages/deep-research.ts` (90 lines)

**Purpose:** Conduct targeted research when Pass 1 results have outliers or missing data.

**Trigger conditions (any of):**
- Missing revenue figures
- Missing employee count
- Missing headquarters location
- Revenue/size mismatch (>$100M revenue but <50 employees)
- Source conflicts (>5x difference between revenue figures)
- Can also be forced via `ctx.forceDeepResearch`

**Process:**
1. Call `detectOutliers()` to check Pass 1 results
2. If triggered, run `runDeepResearch()` - parallel Perplexity queries for revenue, employees, location
3. Merge findings into `ctx.pass1Result` (prepends to existing evidence arrays)

**Reads from context:** `ctx.pass1Result`, `ctx.domain`, `ctx.searchModel`, `ctx.forceDeepResearch`
**Writes to context:** `ctx.outlierFlags`, `ctx.deepResearchResult`, modifies `ctx.pass1Result`

---

### Stage 5: URL Selection
**File:** `pipeline/stages/url-selection.ts` (51 lines)

**Purpose:** Intelligently select which URLs to scrape based on what data Pass 1 already found.

**URL Tiers:**
- **Tier 1 (Essential)** - Always scraped: company website, LinkedIn page
- **Tier 2 (Data Aggregators)** - Conditionally: Crunchbase, ZoomInfo, Apollo, Growjo
- **Tier 3 (Low Value)** - Never scraped: Wikipedia, Glassdoor, Indeed, news

**Selection logic:**
```
Pass 1 found revenue AND employees → Tier 1 only (2 URLs)
Pass 1 found one of them           → Tier 1 + 2 Tier 2 (up to 4 URLs)
Pass 1 found neither               → Tier 1 + 4 Tier 2 (up to 6 URLs)
```

**Reads from context:** `ctx.pass1Result`, `ctx.domain`
**Returns:** `urlsToScrape[]` (passed directly to stage 6, not stored on context)

---

### Stage 6: Scraping
**File:** `pipeline/stages/scraping.ts` (33 lines)

**Purpose:** Scrape selected URLs using Firecrawl to get clean markdown content.

**Process:**
1. Call `scrapeMultipleUrlsWithCost()` with the selected URLs
2. Store scraped content as a `Map<url, markdown>`
3. Track Firecrawl credits and scrape count

**Reads from context:** `ctx.firecrawlApiKey`
**Writes to context:** `ctx.scrapedContent`, `ctx.scrapeResult`, `ctx.costs`

---

### Stage 7: Entity Validation
**File:** `pipeline/stages/entity-validation.ts` (68 lines)

**Purpose:** Detect if Pass 1 identified the wrong company (entity mismatch).

**Process:**
1. Call `detectEntityMismatch()` - checks if company name appears in scraped content
2. If mismatch detected:
   - Re-run Pass 1 in **strict mode** (`pass1_identifyUrlsStrict`)
   - Merge revenue evidence from both original and strict passes
   - Re-scrape with corrected URLs
   - Preserve LinkedIn candidates, headquarters, and employee data from whichever pass has better data

**Reads from context:** `ctx.pass1Result`, `ctx.domain`, `ctx.scrapedContent`, `ctx.searchModel`
**Writes to context:** May replace `ctx.pass1Result` and `ctx.scrapedContent` entirely

---

### Stage 8: LinkedIn Validation
**File:** `pipeline/stages/linkedin-validation.ts` (165 lines)

**Purpose:** Extract the company's LinkedIn URL from scraped content and validate it.

**LinkedIn URL priority:**
1. **Company website** (most authoritative) - search scraped company site for LinkedIn links
2. **Direct scrape** - if no pages scraped, try scraping `https://{domain}` directly
3. **Pass 1 candidates** - use `linkedin_url_candidates[0]` (highest confidence)
4. **Pass 1 urls_to_crawl** - last resort, check if any URL is a LinkedIn company page

**Validation (for both Pass 1 and website sources):**
- Call `validateLinkedInPage()` - scrapes the LinkedIn page
- Compares employee count and location against Pass 1 expectations
- Rejects if >20% mismatch (likely wrong company or parent company page)

**Employee count extraction:**
- If LinkedIn validation finds employee count, store it
- If not, search all scraped content for `X employees` patterns

**Reads from context:** `ctx.pass1Result`, `ctx.domain`, `ctx.scrapedContent`, `ctx.firecrawlApiKey`
**Writes to context:** `ctx.linkedinUrl`, `ctx.linkedinSource`, `ctx.linkedinEmployeeCount`

---

### Stage 9: Pass 2 Analysis
**File:** `pipeline/stages/pass2-analysis.ts` (37 lines)

**Purpose:** Analyze all scraped content using GPT-4o-mini to extract structured data.

**Process:**
1. Call `pass2_analyzeContentWithUsage()` with scraped content + Pass 1 context
2. GPT extracts: business description, location, revenue band, employee band, NAICS codes, quality metrics, ICP matching

**Reads from context:** `ctx.enrichmentDomain`, `ctx.pass1Result`, `ctx.scrapedContent`, `ctx.analysisModel`, `ctx.domain`
**Writes to context:** `ctx.pass2Result`, `ctx.pass2RawResponse`, `ctx.costs.pass2Usage`

---

### Stage 10: Data Estimation
**File:** `pipeline/stages/data-estimation.ts` (182 lines) - the largest stage

**Purpose:** Fill missing revenue/size data, apply LinkedIn data, run sanity checks, recalculate ICP.

**Process (in order):**

1. **Diagnostics** - Add deep research info and domain verification to `result.diagnostics`

2. **LinkedIn URL override** - Replace Pass 2 LinkedIn with our validated LinkedIn (more reliable)

3. **LinkedIn employee count** - If Pass 2 has unknown size but LinkedIn had employees, use LinkedIn

4. **Revenue estimation hierarchy:**
   - Pass 1 evidence (actual figures from web search) → `pickRevenueBandFromEvidence()`
   - Pass 2 extracted revenue (from scraped content)
   - Employee-based estimate → `estimateRevenueBandFromEmployeesAndNaics()`
   - Industry averages → `estimateFromIndustryAverages()`

5. **Size estimation hierarchy:**
   - LinkedIn employee count (high confidence)
   - Revenue-based estimate → `estimateEmployeeBandFromRevenue()`
   - Industry averages (low confidence)

6. **Sanity check** - `validateRevenueVsEmployees()` adjusts if inconsistent

7. **ICP recalculation** - Recalculate `revenue_pass` and `target_icp` with final numbers

**Reads from context:** `ctx.pass1Result`, `ctx.pass2Result`, `ctx.linkedinUrl`, `ctx.linkedinEmployeeCount`, `ctx.deepResearchResult`, `ctx.outlierFlags`, `ctx.domainResolution`, `ctx.forceDeepResearch`
**Writes to context:** Modifies `ctx.pass2Result` in place (revenue, size, quality, diagnostics, ICP)

---

### Stage 11: Parent Enrichment
**File:** `pipeline/stages/parent-enrichment.ts` (99 lines)

**Purpose:** Inherit revenue/size from parent company when the child company has weak data.

**Condition:** Runs if Pass 1 detected a parent company AND child has weak data:
- No revenue, or revenue below $10M passing threshold
- Size is unknown or ≤50 employees

**Process:**
1. Call `guessParentDomain()` to map parent name to domain (uses `KNOWN_PARENT_DOMAINS` map of ~55 major companies, plus heuristic guessing)
2. Look up parent in database via `getCompanyByDomain()`
3. If parent found with good data:
   - Inherit revenue (mark `inherited_revenue = true`)
   - Inherit size if child is small (mark `inherited_size = true`)
   - Set `parent_company_name` and `parent_company_domain`
   - Recalculate ICP with inherited data

**Reads from context:** `ctx.pass1Result`, `ctx.pass2Result`
**Writes to context:** Modifies `ctx.pass2Result` (revenue, size, quality, ICP, parent fields)

---

### Stage 12: Final Assembly
**File:** `pipeline/stages/final-assembly.ts` (97 lines)

**Purpose:** Calculate final costs, compile performance metrics, assemble the response.

**Process:**
1. **Cost breakdown:**
   ```
   AI Cost     = Pass 1 + Pass 2 + Deep Research (if triggered)
   Firecrawl   = credits × $0.0001
   Total       = AI Cost + Firecrawl
   ```

2. **Performance metrics:** `pass1_ms`, `scraping_ms`, `pass2_ms`, `total_ms`, `scrape_count`, `avg_scrape_ms`

3. **Raw API responses:** Domain resolution, Pass 1, Pass 2, Deep Research (for debugging)

4. **Console logging:** Prints cost breakdown and timing summary

**Reads from context:** `ctx.costs`, `ctx.timing`, `ctx.pass2Result`, `ctx.deepResearchResult`, `ctx.domainResolution`, `ctx.pass1RawResponse`, `ctx.pass2RawResponse`
**Returns:** `EnrichmentResultWithCost` (the final response object)

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

1. **Cache Check** - Query database for existing contact by email (<10ms)
2. **ZoomInfo Authentication** - Check cached JWT token (23.5-hour cache)
3. **ZoomInfo Enrichment API** - Send email + optional fields, receive enriched data
4. **Response Processing** - Extract name, phones, title, LinkedIn URL, location
5. **Database Storage** - Upsert contact record
6. **Response** - Return enriched contact with `was_cached`, `credits_used`, `response_time_ms`

---

## Cost Tracking & Optimization

### Cost Components

| Component | Typical Cost | Notes |
|-----------|-------------|-------|
| Pass 1 (Perplexity) | $0.01-0.03 | ~1500-2500 tokens |
| Pass 2 (GPT-4o-mini) | $0.001-0.003 | ~3000-5000 input tokens |
| Deep Research | $0.01-0.02 | Only when triggered |
| Firecrawl | $0.01-0.30 | 1-6 pages × 1-5 credits each |
| **Total fresh** | **$0.02-0.04** | Typical enrichment |
| **Cached hit** | **$0.00** | Database lookup only |

### Cost Optimization Strategies

1. **Caching** - Database check before any API calls
2. **Smart scraping** - Conditional Tier 2 based on Pass 1 results (saves 50-70% Firecrawl credits)
3. **Deep research triggers** - Only when outliers detected (saves ~$0.02/enrichment)
4. **CostAccumulator** - Central tracking prevents double-counting across stages

---

## Quality Assurance Mechanisms

### Entity Mismatch Detection (Stage 7)
- Checks if Pass 1 company name appears in scraped content
- If mismatch: re-runs Pass 1 in strict mode, merges evidence from both passes

### LinkedIn Validation (Stage 8)
- Validates LinkedIn URL against expected employees/location
- Rejects if >20% mismatch (wrong company or parent page)
- Validates URLs from both website and Pass 1 sources

### Revenue Validation (Stage 10)
- `validateRevenueVsEmployees()` checks revenue vs employee count consistency
- Applies industry-specific ratios
- Adjusts revenue band if mismatch detected

### Quality Metrics
- Every field gets confidence level (high/medium/low) + reasoning
- Diagnostics track: revenue sources found, deep research triggers, domain verification, revenue adjustments

---

## External Integrations

| Service | Model/API | Used In | Purpose |
|---------|-----------|---------|---------|
| Perplexity | `perplexity/sonar-pro` | Stages 2, 4 | Web search with real-time internet |
| OpenAI | `openai/gpt-4o-mini` | Stage 9 | Content analysis and extraction |
| Gemini | `google/gemini-2.0-flash-exp` | Stage 3 | Fallback LinkedIn search |
| Firecrawl | REST API | Stages 1, 3, 6 | Web scraping + Google search |
| Supabase | PostgreSQL | Stage 11 (parent), DB save | Data storage |
| ZoomInfo | REST API | Contact enrichment | Contact data |

All AI models accessed via `@ai-sdk/gateway` (single `gateway(modelId)` call).

---

## Performance Characteristics

### Typical Execution Times

| Stage | Time (ms) | Notes |
|-------|-----------|-------|
| Domain Resolution | 500-1,000 | Firecrawl search |
| Pass 1 (Web Search) | 1,000-4,000 | Perplexity API |
| LinkedIn Search | 1,000-3,000 | Only if Pass 1 found nothing |
| Deep Research | 1,000-3,000 | Only if triggered |
| URL Selection | <1 | Pure logic |
| Scraping | 500-5,000 | Depends on page count |
| Entity Validation | 0-5,000 | 0 if no mismatch; 5s if re-run |
| LinkedIn Validation | 500-2,000 | Scrapes + validates LinkedIn page |
| Pass 2 (Analysis) | 2,000-5,000 | GPT-4o-mini API |
| Data Estimation | <1 | Pure logic |
| Parent Enrichment | 0-100 | DB lookup only |
| Final Assembly | <1 | Pure logic |
| **Total** | **10,000-25,000** | ~10-25 seconds typical |

### Cached Hit Performance
- Database lookup: ~10-50ms
- Response: <100ms total
- Cost: $0.00

### Test Results (10 companies, Feb 2026)

| Domain | Cost | Time | All stages |
|--------|------|------|-----------|
| fijiwater.com | $0.023 | 16.3s | Pass |
| medfinefoods.com | $0.029 | 166.6s | Pass (retries) |
| bwfoods.com | $0.016 | 13.4s | Pass |
| universalyums.com | $0.022 | 15.0s | Pass |
| capitalcityfruit.com | $0.019 | 14.6s | Pass |
| bstseafood.com | $0.018 | 21.7s | Pass |
| ccclark.com | $0.017 | 13.8s | Pass |
| bydsa.com | $0.013 | 16.7s | Pass |
| bartlettny.com | $0.019 | 20.8s | Pass |
| flashfoods.com | $0.014 | 13.0s | Pass |

Average: **$0.019/enrichment**, **~17s** (excluding outlier)

---

## Summary

The Benriched enrichment system is a modular 12-stage pipeline that:

1. **Resolves domains** and searches the web (Stages 1-3)
2. **Deep dives** into outliers and conflicts (Stage 4)
3. **Intelligently scrapes** selected URLs to minimize cost (Stages 5-6)
4. **Validates** entity identity and LinkedIn accuracy (Stages 7-8)
5. **Analyzes content** with GPT-4o-mini (Stage 9)
6. **Fills gaps** using estimation hierarchies and sanity checks (Stage 10)
7. **Inherits parent data** for weak subsidiaries/brands (Stage 11)
8. **Assembles costs** and returns the final result (Stage 12)

Each stage is isolated in its own file, reads/writes a shared `EnrichmentContext`, and can be debugged or tested independently. The orchestrator shows the full pipeline flow in 12 lines.

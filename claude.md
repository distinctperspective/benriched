# Benriched System Documentation for Claude

## Quick Navigation

**Documentation by Audience:**
- **API Consumers:** See [docs/API.md](docs/API.md) for endpoint documentation, request/response formats, authentication
- **Developers:** See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for setup, testing, deployment, contributing
- **Architects:** See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design, 12-stage pipeline, cost optimization
- **DBAs:** See [docs/DATABASE.md](docs/DATABASE.md) for schema, indexes, and common queries

**Directory Structure:**
```
benriched/
├── api/
│   └── index.ts                 # Vercel serverless handler (uses Hono app)
├── src/
│   ├── index.ts                 # Main Hono application
│   ├── server.ts                # Local dev server startup
│   ├── enrichment/
│   │   └── enrich.js            # Company enrichment logic
│   ├── lib/
│   │   ├── supabase.ts          # Database utilities
│   │   ├── requests.ts          # Request logging
│   │   ├── persona.ts           # Persona matching logic
│   │   ├── research.ts          # Contact research logic
│   │   ├── contact-enrich.ts    # ZoomInfo contact enrichment
│   │   └── outreach.ts          # Email sequence generation
│   ├── middleware/
│   │   ├── auth.ts              # API key authentication
│   │   └── rateLimit.ts         # Rate limiting
│   └── routes/
│       ├── v1/                  # NEW: v1 API endpoints
│       │   ├── enrich/
│       │   │   ├── company.ts   # POST /v1/enrich/company
│       │   │   ├── contact.ts   # POST /v1/enrich/contact
│       │   │   └── index.ts
│       │   ├── research/
│       │   │   ├── contact.ts   # POST /v1/research/contact
│       │   │   └── index.ts
│       │   ├── match/
│       │   │   ├── persona.ts   # POST /v1/match/persona
│       │   │   └── index.ts
│       │   ├── generate/
│       │   │   ├── email-sequence.ts  # POST /v1/generate/email-sequence
│       │   │   └── index.ts
│       │   ├── health.ts        # GET /v1/health
│       │   └── index.ts         # v1 router
│       ├── legacy/              # NEW: backwards-compatible aliases
│       │   └── aliases.ts       # Legacy endpoint aliases
│       ├── health.ts            # Legacy health check
│       ├── enrich.ts            # Legacy company enrichment
│       ├── persona.ts           # Legacy persona matching
│       ├── research.ts          # Legacy contact research
│       └── outreach.ts          # Legacy email sequence
├── docs/
│   ├── API.md                   # Complete API documentation
│   ├── ARCHITECTURE.md          # System architecture and 12-stage pipeline
│   ├── DEVELOPMENT.md           # Developer setup and workflow
│   └── DATABASE.md              # Database schema and queries
├── claude.md                    # This file (Claude AI system docs)
├── README.md                    # Project overview and quick start
├── vercel.json                  # Vercel deployment config
└── package.json
```

**Key Documentation Files:**
- [docs/API.md](docs/API.md) - Complete API reference for endpoint consumers
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - System architecture, 12-stage pipeline, cost tracking
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) - Developer setup, testing, deployment guide
- [docs/DATABASE.md](docs/DATABASE.md) - Database schema, indexes, queries, data types
- [docs/integrations/VELLIUM.md](docs/integrations/VELLIUM.md) - Vellium workflow integration guide

**Key Source Files:**
- [src/index.ts](src/index.ts) - Main app with v1 and legacy route mounting
- [src/routes/v1/](src/routes/v1/) - New v1 API endpoints (versioned)
- [src/routes/legacy/aliases.ts](src/routes/legacy/aliases.ts) - Legacy endpoint mappings (backwards compatible)
- [api/index.ts](api/index.ts) - Vercel serverless handler (wraps Hono app)

---

## Overview

Benriched is an AI-powered company and contact enrichment system that combines web search, web scraping, and AI analysis to extract and validate company data including revenue, employee count, location, industry classification, and ICP matching.

**Key Technologies:**
- Perplexity Sonar Pro (web search)
- OpenAI GPT-4o-mini (content analysis)
- Firecrawl (web scraping)
- Supabase PostgreSQL (data storage)
- ZoomInfo (contact enrichment)

---

## Base URLs

- **Local Development**: `http://localhost:8787`
- **Production**: `https://benriched.vercel.app`

---

## Authentication

All endpoints require authentication via one of these methods:
1. Query parameter: `?api_key=amlink21`
2. Header: `X-API-Key: amlink21`
3. Authorization header: `Authorization: Bearer amlink21`
4. Request body: `"api_key": "amlink21"`

---

## Server-Sent Events (SSE) Streaming

The `/v1/enrich/company` endpoint supports optional real-time progress streaming via Server-Sent Events (SSE). This allows clients to track enrichment progress in real-time during the 30-40 second enrichment process.

**For comprehensive SSE documentation including:** event format, payload structure, 14 stages, React examples, and more detailed JavaScript examples, see [docs/API.md - Server-Sent Events (SSE) Streaming](docs/API.md#server-sent-events-sse-streaming).

### Quick Start

Enable streaming by adding `?stream=true` query parameter to the request:

```bash
# Non-streaming (standard JSON response)
curl -X POST "https://benriched.vercel.app/v1/enrich/company" \
  -H "Authorization: Bearer amlink21" \
  -H "Content-Type: application/json" \
  -d '{"domain": "lincolnpremiumpoultry.com"}'

# Streaming (real-time progress events)
curl -N -X POST "https://benriched.vercel.app/v1/enrich/company?stream=true" \
  -H "Authorization: Bearer amlink21" \
  -H "Content-Type: application/json" \
  -d '{"domain": "lincolnpremiumpoultry.com"}'
```

The `-N` flag in curl disables buffering for real-time output.

### Event Format

Each SSE event has:
- **id**: Unique event identifier (UUID)
- **event**: Type ("progress", "complete", or "error")
- **data**: Event payload (JSON) with stage, message, timing, cost, etc.

```
id: 550e8400-e29b-41d4-a716-446655440000
event: progress
data: {"stage":"pass1_search","message":"Web search complete","status":"complete","timestamp":"2026-01-25T10:30:02.000Z","timing":{"elapsed_ms":2000},"cost":{"usd":0.0203}}
```

### Enrichment Stages

14 stages emit progress events during enrichment:

| Stage | Type | Description |
|-------|------|-------------|
| cache_check | Check | Checking for cached company data |
| domain_resolution | API | Resolving domain to company website |
| pass1_search | AI | Web search with Perplexity Sonar Pro |
| deep_research | AI | Deep research (triggered if outliers detected) |
| url_selection | Process | Selecting URLs to scrape |
| scraping | API | Scraping with Firecrawl |
| entity_validation | Process | Validating company identity |
| linkedin_validation | Extract | Extracting and validating LinkedIn profile |
| pass2_analysis | AI | Content analysis with GPT-4o-mini |
| data_estimation | Process | Estimating revenue and employee data |
| parent_enrichment | Process | Parent company data inheritance (conditional) |
| final_assembly | Process | Calculating total costs |
| database_save | Database | Saving enrichment results to database |
| complete | Done | Final completion event with full data |

### JavaScript EventSource Example

```javascript
const domain = 'lincolnpremiumpoultry.com';
const apiKey = 'amlink21';

const eventSource = new EventSource(
  `https://benriched.vercel.app/v1/enrich/company?stream=true&domain=${domain}&api_key=${apiKey}`
);

// Listen for progress updates
eventSource.addEventListener('progress', (event) => {
  const data = JSON.parse(event.data);
  console.log(`[${data.stage}] ${data.message}`);

  if (data.timing) {
    console.log(`⏱️  ${data.timing.elapsed_ms}ms`);
  }

  if (data.cost) {
    console.log(`💰 $${data.cost.usd.toFixed(4)}`);
  }
});

// Listen for completion
eventSource.addEventListener('complete', (event) => {
  const data = JSON.parse(event.data);
  console.log('✅ Enrichment complete!');
  console.log('Company:', data.data.company_name);
  console.log('Total cost:', `$${data.cost.usd.toFixed(4)}`);
  eventSource.close();
});

// Listen for errors
eventSource.addEventListener('error', (event) => {
  const data = JSON.parse(event.data);
  console.error(`❌ ${data.message}`);
  eventSource.close();
});
```

### Backwards Compatibility

- **Streaming is opt-in** via `?stream=true` query parameter (default: false)
- **Non-streaming mode unchanged** - all existing API clients continue to work without modification
- **Zero breaking changes** - legacy `/enrich` endpoint also supports `?stream=true`
- **Identical results** - both modes produce identical final enrichment data
- **Performance overhead** - less than 5ms per event

---

## API Endpoints

### POST /enrich

Enrich a company domain with detailed business intelligence data.

**Request:**
```bash
curl -X POST "https://benriched.vercel.app/enrich" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: amlink21" \
  -d '{
    "domain": "lincolnpremiumpoultry.com",
    "hs_company_id": "123456",
    "force_refresh": false,
    "deep_research": false,
    "async": false
  }'
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `domain` | string | Yes | Company domain (e.g., "example.com") |
| `hs_company_id` | string | No | HubSpot company ID for tracking |
| `force_refresh` | boolean | No | Force re-enrichment, bypass cache (default: false) |
| `deep_research` | boolean | No | Trigger deep research pass for uncertain data (default: false) |
| `async` | boolean | No | Process asynchronously, return immediately (default: false) |

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "9a88c622-dd1d-4e35-9cd3-0cb5cc93543f",
    "domain": "lincolnpremiumpoultry.com",
    "company_name": "Lincoln Premium Poultry",
    "website": "https://lincolnpremiumpoultry.com",
    "linkedin_url": "https://www.linkedin.com/company/lincoln-premium-poultry",
    "business_description": "Premium poultry producer...",
    "company_size": "1,001-5,000 Employees",
    "company_revenue": "500M-1B",
    "city": "Fremont",
    "state": "Nebraska",
    "hq_country": "US",
    "is_us_hq": true,
    "is_us_subsidiary": true,
    "naics_codes_6_digit": [
      {
        "code": "311615",
        "description": "Poultry Processing"
      }
    ],
    "naics_codes_csv": "311615",
    "target_icp": true,
    "target_icp_matches": [
      {
        "code": "311615",
        "description": "Poultry Processing"
      }
    ],
    "source_urls": [
      "https://lincolnpremiumpoultry.com",
      "https://www.crunchbase.com/organization/lincoln-premium-poultry"
    ],
    "quality": {
      "size": {
        "reasoning": "Employee count confirmed by multiple sources",
        "confidence": "high"
      },
      "revenue": {
        "reasoning": "Estimated from authoritative sources",
        "confidence": "high"
      },
      "industry": {
        "reasoning": "NAICS codes based on business activities",
        "confidence": "high"
      },
      "location": {
        "reasoning": "Confirmed by multiple sources",
        "confidence": "high"
      }
    },
    "created_at": "2026-01-15T09:47:08.551273+00:00",
    "updated_at": "2026-01-18T10:49:53.144263+00:00",
    "last_enriched_at": "2026-01-15T09:47:08.551273+00:00",
    "performance_metrics": {
      "pass1_ms": 3695,
      "pass2_ms": 7916,
      "total_ms": 21912,
      "scraping_ms": 10281,
      "scrape_count": 3,
      "avg_scrape_ms": 3427
    }
  },
  "cached": false,
  "cost": {
    "ai": {
      "pass1": {
        "model": "perplexity/sonar-pro",
        "inputTokens": 996,
        "outputTokens": 1156,
        "totalTokens": 2152,
        "costUsd": 0.020328
      },
      "pass2": {
        "model": "openai/gpt-4o-mini",
        "inputTokens": 2636,
        "outputTokens": 396,
        "totalTokens": 3032,
        "costUsd": 0.002261
      },
      "total": {
        "inputTokens": 3632,
        "outputTokens": 1552,
        "totalTokens": 5184,
        "costUsd": 0.022589
      }
    },
    "firecrawl": {
      "scrapeCount": 1,
      "creditsUsed": 2,
      "costUsd": 0.00198
    },
    "total": {
      "costUsd": 0.024569
    }
  }
}
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether the enrichment succeeded |
| `data` | object | Enriched company data |
| `cached` | boolean | Whether data came from cache |
| `cost` | object | Breakdown of API costs |
| `performance_metrics` | object | Timing information for each pass |

**Performance:**

- **Cached hit**: ~100-200ms
- **Fresh enrichment**: ~30-40 seconds
  - Pass 1 (web search): ~10-15s
  - Scraping: ~1-2s
  - Pass 2 (analysis): ~15-20s
- **With deep research**: +20-30 seconds

**Cost:**

- **Cached hit**: $0.00
- **Fresh enrichment**: ~$0.02-0.03
- **With deep research**: +$0.01-0.02

---

### POST /enrich/contact

Enrich contact information using ZoomInfo API.

**Request:**
```bash
curl -X POST "https://benriched.vercel.app/enrich/contact?api_key=amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "nellie@oishii.com",
    "first_name": "Nellie",
    "last_name": "Arroyo",
    "job_title": "General Manager, Production Operations",
    "hs_company_id": "123456",
    "hs_contact_id": "789012"
  }'
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `email` | string | Yes | Contact email address |
| `first_name` | string | No | Contact first name |
| `last_name` | string | No | Contact last name |
| `full_name` | string | No | Contact full name |
| `job_title` | string | No | Contact job title |
| `company_name` | string | No | Contact company name |
| `hs_company_id` | string | No | HubSpot company ID |
| `hs_contact_id` | string | No | HubSpot contact ID |

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "fadf8db2-ebcc-4d6a-84b4-4fe40e5fba4d",
    "email_address": "nellie@oishii.com",
    "first_name": "Nellie",
    "last_name": "Arroyo",
    "full_name": "Nellie Arroyo",
    "job_title": "General Manager, Production Operations",
    "cell_phone": "(248) 835-7718",
    "linked_profile_url": "https://www.linkedin.com/in/nellie-arroyo-664877105",
    "hubspot_contact_id": "789012",
    "hubspot_company_id": "123456",
    "created_at": "2026-01-21T08:58:17.490467+00:00",
    "updated_at": "2026-01-21T08:58:17.490467+00:00"
  },
  "was_cached": false,
  "credits_used": 1,
  "response_time_ms": 1315
}
```

**Match Statuses:**

- `MATCH` - Confident match found
- `CONFIDENT_MATCH` - High confidence match
- `FULL_MATCH` - Perfect match
- `NO_MATCH` - No matching contact found
- `OPT_OUT` - Contact opted out of data sharing

**Features:**

- ✅ JWT token caching (23.5-hour expiration)
- ✅ LinkedIn URL extraction from externalUrls
- ✅ Phone number retrieval (mobile and direct)
- ✅ Job title normalization
- ✅ Database storage in contacts table
- ✅ Request logging with raw API responses

### POST /research/contact

Research a prospect for outbound sales personalization.

**Request:**
```bash
curl -X POST "https://benriched.vercel.app/research/contact?api_key=amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "prospect_name": "Jessica Packard",
    "company_name": "Timeero",
    "linkedin_url": "https://www.linkedin.com/in/jessica-packard"
  }'
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prospect_name` | string | Yes | Full name of the prospect |
| `company_name` | string | Yes | Company name |
| `linkedin_url` | string | No | LinkedIn profile URL |

**Response:**
```json
{
  "success": true,
  "data": {
    "prospect_name": "Jessica Packard",
    "company_name": "Timeero",
    "research_summary": "Jessica Packard is a key decision-maker at Timeero...",
    "key_insights": [
      "Insight about prospect's role and responsibilities",
      "Information about company's recent activities"
    ],
    "personalization_angles": [
      "Angle 1 for outbound sales",
      "Angle 2 for outbound sales"
    ],
    "recommended_approach": "Recommended sales approach based on research"
  },
  "response_time_ms": 2500
}
```

**Features:**

- ✅ Web search using Perplexity Sonar Pro
- ✅ Structured JSON output
- ✅ Personalization insights for sales
- ✅ LinkedIn profile integration

---

### POST /persona

Match a job title to a sales persona.

**Request:**
```bash
curl -X POST "https://benriched.vercel.app/persona?api_key=amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Food Safety Manager"
  }'
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Job title to classify |

**Response:**
```json
{
  "success": true,
  "data": {
    "title": "Food Safety Manager",
    "matched_from": "ai",
    "primary_persona": {
      "id": "7000a515-0f02-4102-a861-537b37acc07f",
      "persona_title": "Quality & EHS",
      "description": "Quality & EHS personnel work alongside other departments...",
      "responsibilities": "...",
      "top_priorities": "...",
      "key_terms": "..."
    },
    "secondary_persona": null,
    "confidence": "high",
    "tier": "Tier 2 (Manager / Recommender)",
    "normalized_title": "Food Safety Manager"
  }
}
```

**Features:**

- ✅ AI-powered title classification
- ✅ Database caching for performance
- ✅ Persona matching with confidence scores
- ✅ Tier classification (Executive, Manager, Contributor)

---

## Error Responses

**Missing API Key:**
```json
{
  "error": "Missing API key. Use ?api_key=<key> or Authorization: Bearer <key>"
}
```

**Unauthorized:**
```json
{
  "error": "Unauthorized",
  "hint": "Include api_key in body, query, X-API-Key header, or Authorization: Bearer <key>"
}
```

**Missing Required Field:**
```json
{
  "error": "Missing required field: domain"
}
```

**Server Error:**
```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

---

## Rate Limiting

- No explicit rate limits currently implemented
- Costs are tracked per request for billing purposes
- Async mode available for long-running enrichments

---

## cURL Examples

**Enrich a company (one-liner):**
```bash
curl -X POST "https://benriched.vercel.app/enrich" -H "Content-Type: application/json" -H "X-API-Key: amlink21" -d '{"domain": "lincolnpremiumpoultry.com"}'
```

**Enrich a contact:**
```bash
curl -X POST "http://localhost:8787/enrich/contact?api_key=amlink21" -H "Content-Type: application/json" -d '{"email": "nellie@oishii.com", "first_name": "Nellie", "last_name": "Arroyo"}'
```

**Research a prospect:**
```bash
curl -X POST "http://localhost:8787/research/contact?api_key=amlink21" -H "Content-Type: application/json" -d '{"prospect_name": "Jessica Packard", "company_name": "Timeero"}'
```

**Match a job title:**
```bash
curl -X POST "http://localhost:8787/persona?api_key=amlink21" -H "Content-Type: application/json" -d '{"title": "Food Safety Manager"}'
```

---

## Enrichment Pipeline Architecture

The system processes domains through 12 stages:

### Stage 0: Domain Normalization & Cache Check
- Strip https://, http://, www. prefixes
- Remove trailing slashes
- Query database for existing record
- Return cached data if found (unless force_refresh=true)

### Stage 1: Domain Resolution
- Use Firecrawl to resolve dead/invalid domains
- Find actual company website if domain is email-only
- Track credits used

### Stage 2: Pass 1 - Web Search (Perplexity Sonar Pro)
- Search web for company information
- Collect revenue evidence (all sources found)
- Extract employee count
- Identify headquarters location
- Detect parent company relationships
- Find LinkedIn URL candidates
- Return URLs to crawl

**Output:**
```typescript
{
  company_name: string;
  parent_company: string | null;
  entity_scope: "operating_company" | "ultimate_parent";
  relationship_type: "standalone" | "subsidiary" | "division" | "brand" | "unknown";
  headquarters: {city, state, country, country_code};
  urls_to_crawl: string[];
  revenue_found: Array<{amount, source, year, is_estimate, scope, source_type, evidence_url, evidence_excerpt}>;
  employee_count_found: {amount, source, scope, source_type} | null;
  linkedin_url_candidates: Array<{url, confidence}>;
}
```

### Stage 3: Deep Research (Conditional - Perplexity Sonar Pro)
Triggered if Pass 1 results have outliers:
- Missing revenue
- Missing employees
- Missing location
- Revenue/size mismatch (>$100M revenue but <50 employees)
- Source conflicts (>5x difference between revenue figures)
- Public company detection

Runs 3 parallel queries: revenue, employee count, location

### Stage 4: Smart URL Categorization & Scraping
**Tier 1 (Always):**
- Company website
- LinkedIn company page

**Tier 2 (Conditional):**
- Crunchbase, Owler, Growjo, ZoomInfo, Apollo
- Added if Pass 1 missing revenue OR employees
- Limit: 2-4 based on data completeness

**Tier 3 (Never):**
- Wikipedia, Glassdoor, Indeed, news articles

**Selection Logic:**
- Both revenue AND employees found → Scrape only Tier 1
- Revenue OR employees found → Scrape Tier 1 + 2 (up to 2)
- Both missing → Scrape Tier 1 + 4 aggregators

### Stage 5: Firecrawl Scraping
- Scrape selected URLs
- Extract clean markdown text
- Track credits used (1-5 credits per page)

### Stage 6: Entity Mismatch Detection
- Check if company name from Pass 1 appears in scraped content
- If mismatch detected: re-run Pass 1 in strict mode
- Preserve revenue/employee evidence from both passes

### Stage 7: LinkedIn Extraction & Validation
Priority order:
1. Company website (most authoritative - no validation needed)
2. Pass 1 results (validate against expected employees/location)
3. Scraped content fallback

Validation rejects if >20% mismatch on employees or location

### Stage 8: Pass 2 - Content Analysis (GPT-4o-mini)
Extract structured data from scraped content:
- Business description (2-4 sentences, identify primary activity)
- Headquarters location (city, state, country, US HQ flag)
- Revenue band (12 bands: 0-500K through 100B-1T)
- Employee band (9 bands: 0-1 through 10,001+)
- NAICS codes (up to 3, 6-digit format)
- Quality metrics for each field

### Stage 9: Revenue & Size Estimation
Fill missing data using hierarchy:
1. Pass 1 evidence (highest priority) - actual figures found
2. Pass 2 findings - extracted from content
3. Revenue ↔ size correlation - industry estimates
4. Industry averages - NAICS code lookups (lowest priority)

Applies sanity checks: validate revenue vs employee consistency

### Stage 10: Parent Company Enrichment
**Triggers when child is weak:**
- No revenue data, OR
- Revenue < $10M, OR
- Size 0-50 employees

**Process:**
- Lookup parent company in database
- Inherit revenue/size if parent has good data
- Mark with inherited_revenue/inherited_size flags
- Recalculate ICP with inherited data

**Known mappings:** 83 major parent companies hardcoded (General Mills, Nestlé, Kraft Heinz, PepsiCo, Coca-Cola, Unilever, etc.)

### Stage 11: Final Assembly & Cost Calculation
- Calculate total cost (AI tokens + Firecrawl credits)
- Compile performance metrics
- Store raw API responses

### Stage 12: Database Storage
- Upsert companies table
- Insert enrichment_requests log entry
- Return response

---

## Revenue Band Options

```
0-500K, 500K-1M, 1M-5M, 5M-10M, 10M-25M, 25M-75M, 75M-200M,
200M-500M, 500M-1B, 1B-10B, 10B-100B, 100B-1T
```

## Employee Band Options

```
0-1 Employees, 2-10 Employees, 11-50 Employees, 51-200 Employees,
201-500 Employees, 501-1,000 Employees, 1,001-5,000 Employees,
5,001-10,000 Employees, 10,001+ Employees
```

---

## Target ICP Matching

A company matches Target ICP if ALL of:
1. Revenue band: $10M-25M or higher
2. Location: US, Mexico, Canada, Puerto Rico, OR has US operations
3. NAICS code: 311 (Food Manufacturing), 424 (Merchant Wholesalers), 722 (Food Service)

---

## Cost Breakdown

**Typical per enrichment: $0.17-0.38**

- Pass 1 (Perplexity): $0.01-0.03
- Pass 2 (GPT-4o-mini): $0.001-0.003
- Firecrawl (3-6 pages): $0.15-0.30
- Deep Research (if triggered): $0.02-0.05

**Cached hit:** $0.00

---

## Database Schema

### companies table

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| domain | TEXT | Company domain (unique) |
| company_name | TEXT | Official name |
| website | TEXT | Company URL |
| linkedin_url | TEXT | LinkedIn page |
| business_description | TEXT | 2-4 sentence description |
| company_size | TEXT | Employee band |
| company_revenue | TEXT | Revenue band |
| city | TEXT | HQ city |
| state | TEXT | HQ state/province |
| hq_country | TEXT | 2-letter ISO code |
| is_us_hq | BOOLEAN | Global HQ in US |
| is_us_subsidiary | BOOLEAN | Has US operations |
| naics_codes_6_digit | JSONB | Array of {code, description} |
| naics_codes_csv | TEXT | Comma-separated codes |
| target_icp | BOOLEAN | Matches ICP criteria |
| target_icp_matches | JSONB | Matching NAICS codes |
| source_urls | JSONB | URLs used for enrichment |
| quality | JSONB | Confidence levels per field |
| performance_metrics | JSONB | Timing data |
| parent_company_name | TEXT | Parent company name |
| parent_company_domain | TEXT | Parent domain |
| inherited_revenue | BOOLEAN | Revenue inherited from parent |
| inherited_size | BOOLEAN | Size inherited from parent |
| created_at | TIMESTAMP | Creation time |
| updated_at | TIMESTAMP | Last update |
| last_enriched_at | TIMESTAMP | Last enrichment |

### enrichment_requests table

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| hs_company_id | TEXT | HubSpot company ID |
| domain | TEXT | Domain enriched |
| company_id | UUID | FK to companies |
| request_source | TEXT | "hubspot" or "api" |
| request_type | TEXT | "enrichment", "cached", "contact-enrich", "contact-cached" |
| was_cached | BOOLEAN | Returned cached data |
| cost_usd | DECIMAL | Total cost |
| response_time_ms | INTEGER | Response time |
| raw_api_responses | JSONB | API responses |
| enrichment_cost | JSONB | Cost breakdown |
| created_at | TIMESTAMP | Request time |

### contacts table

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| email_address | TEXT | Email (unique) |
| first_name | TEXT | First name |
| last_name | TEXT | Last name |
| job_title | TEXT | Job title |
| direct_phone | TEXT | Direct phone |
| cell_phone | TEXT | Mobile phone |
| linked_profile_url | TEXT | LinkedIn URL |
| hubspot_contact_id | TEXT | HubSpot ID |
| hubspot_company_id | TEXT | HubSpot company ID |
| company_id | UUID | FK to companies |
| created_at | TIMESTAMP | Creation time |
| updated_at | TIMESTAMP | Last update |

---

## Performance Characteristics

**Typical Execution Times:**
- Pass 1 (Perplexity): 1-2 seconds
- Deep Research (if triggered): 1-3 seconds
- Scraping (Firecrawl): 2-5 seconds
- Pass 2 (GPT-4o-mini): 2-4 seconds
- Database save: 0.1-0.5 seconds
- **Total: 7-15 seconds**

**Cached hit:** <100ms

**Token Usage:**
- Pass 1: 1,500-2,500 input, 800-1,200 output
- Pass 2: 3,000-5,000 input, 500-800 output
- Deep Research (per query): 200-400 input, 200-400 output

---

## External Integrations

### Perplexity Sonar Pro
- Model: `perplexity/sonar-pro`
- Used in: Pass 1, Deep Research
- Cost: $0.003 per 1K input tokens, $0.012 per 1K output tokens
- Purpose: Web search with real-time internet access

### OpenAI GPT-4o-mini
- Model: `openai/gpt-4o-mini`
- Used in: Pass 2
- Cost: $0.00015 per 1K input tokens, $0.0006 per 1K output tokens
- Purpose: Content analysis and data extraction

### Firecrawl
- Purpose: Extract text content from websites
- Cost: $0.10 per 1000 credits
- Typical: 1-5 credits per page

### ZoomInfo
- Used in: `/enrich/contact` endpoint
- Credentials: ZI_USERNAME, ZI_PASSWORD, ZI_AUTH_URL, ZI_ENRICH_URL
- Returns: Contact details, company info, job title validation

---

## Key Design Decisions

1. **Two-Pass AI Architecture:** Perplexity for web search, GPT for analysis
2. **Smart URL Selection:** Avoid expensive scraping when not needed
3. **Deep Research Triggers:** Automatic outlier detection
4. **Entity Mismatch Detection:** Prevent enriching wrong company
5. **Parent Company Inheritance:** Enable ICP matching for subsidiaries
6. **Cache-First Approach:** Avoid re-enriching known domains
7. **Transparent Cost Tracking:** Full breakdown of all API usage

---

## Error Handling

**Graceful Degradation:**
- Pass 1 fails → Return error
- Scraping fails → Continue with Pass 2 using only Pass 1 data
- Pass 2 fails → Return Pass 1 results with lower confidence
- Database save fails → Log error, return enrichment result anyway

**Validation:**
- JSON output from all LLM calls
- Domain normalization
- Revenue/employee bands from predefined lists
- NAICS codes in 6-digit format

---

## Implementation Notes

When implementing or modifying the system:

1. **Always check database first** before making API calls (cache check)
2. **Track all token usage** for cost calculations
3. **Validate Firecrawl credits** returned from scraping
4. **Preserve revenue evidence** from Pass 1 through Pass 2
5. **Validate LinkedIn URLs** before including in final output
6. **Sanity check** revenue vs employee count before finalizing
7. **Recalculate ICP** after parent company inheritance
8. **Log all requests** to enrichment_requests table for analytics

---

## Quick Reference: Revenue Priority

When multiple revenue sources found:
1. SEC filings / audited financials (highest authority)
2. Investor relations / earnings releases
3. Company press releases
4. Reputable media (Forbes, Bloomberg, Reuters, WSJ)
5. Wikipedia (as pointer only)
6. Directory/estimate sites (Growjo, Owler, Zippia, ZoomInfo) (lowest)

Only apply 5x conflict rule within same entity scope.

---

## Contact Data Extraction

From ZoomInfo response:
- Extract first_name, last_name, full_name
- Extract phone numbers (direct, mobile, other)
- Extract job_title and management_level
- Extract company_name and company_website
- Extract location (city, state, country)
- Extract LinkedIn URL from externalUrls array
- Cache JWT token for 23.5 hours (refresh 30min early)

---

## API Reorganization (January 2026)

### Overview

The API has been reorganized to add versioning and improve naming consistency while maintaining full backwards compatibility.

**Key Changes:**

1. **Added v1 Versioning**: New endpoints use `/v1/` prefix
2. **Improved Naming**: Action-based namespaces (enrich, research, match, generate)
3. **Unified Codebase**: Vercel now uses Hono app instead of monolithic handler
4. **Full Backwards Compatibility**: All legacy endpoints remain active indefinitely

### New v1 Endpoints

| New Endpoint | Old Endpoint | Purpose |
|-------------|------------|---------|
| `POST /v1/enrich/company` | `POST /enrich` | Company enrichment by domain |
| `POST /v1/enrich/contact` | `POST /enrich/contact` | Contact enrichment by email |
| `POST /v1/match/persona` | `POST /persona` | Job title to persona matching |
| `POST /v1/research/contact` | `POST /research/contact` | Prospect research for outbound |
| `POST /v1/generate/email-sequence` | `POST /outreach/email-sequence` | Email sequence generation |
| `GET /v1/health` | `GET /health` | Health check |

### Legacy Endpoints (Still Supported)

All legacy endpoints (`/enrich`, `/persona`, `/research/contact`, etc.) remain fully functional and respond identically to their v1 counterparts. No migration required.

### File Organization

**New Routes Structure:**
- `src/routes/v1/` - All v1 endpoints organized by action
  - `enrich/company.ts` and `enrich/contact.ts` - Enrichment handlers
  - `research/contact.ts` - Contact research handler
  - `match/persona.ts` - Persona matching handler
  - `generate/email-sequence.ts` - Email sequence handler
  - `health.ts` - Health check

- `src/routes/legacy/aliases.ts` - Legacy endpoint aliases (map old URLs to v1 handlers)

**Updated Files:**
- `src/index.ts` - Main app router with v1 and legacy route mounting
- `api/index.ts` - Simplified to use Hono handler via `handle()` from `hono/vercel`

### Authentication Changes

The auth middleware now supports all methods equally:
- **Priority 1**: `Authorization: Bearer <key>` header (recommended)
- **Priority 2**: `X-API-Key: <key>` header
- **Priority 3**: `?api_key=<key>` query parameter
- **Removed**: Body `api_key` field (security best practice)

All endpoints except `/` and `/v1/health` require authentication.

### Migration Path

**For API Consumers:**
1. ✅ Old endpoints work indefinitely - no forced migration
2. ✅ New endpoints available immediately at `/v1/`
3. ✅ Responses are identical - just update the URL path
4. ✅ Same authentication methods work on both

**Recommended Action:**
- Update client code to use v1 endpoints at your pace
- No breaking changes or timelines

### Testing & Validation

When testing enrichment:
1. Use domains with complete data first
2. Verify Pass 1 revenue collection is comprehensive
3. Validate Pass 2 field extraction accuracy
4. Check deep research triggers on outliers
5. Verify parent company lookups and inheritance
6. Validate ICP matching logic
7. Confirm cost calculations accuracy
8. Test error handling with invalid/missing data

### API Documentation

For complete API documentation including all request/response formats, see [docs/API.md](docs/API.md)

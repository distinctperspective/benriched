# Benriched API Documentation

## Overview

Benriched is an AI-powered company and contact enrichment API that combines web search, web scraping, and AI analysis to extract and validate business intelligence data.

**Base URLs:**
- Local: `http://localhost:8787`
- Production: `https://benriched.vercel.app`

---

## Authentication

All endpoints (except `/` and `/v1/health`) require authentication via one of these methods:

### Authentication Methods (in order of priority)

1. **Query Parameter**: `?api_key=amlink21`
2. **Authorization Header**: `Authorization: Bearer amlink21`
3. **X-API-Key Header**: `X-API-Key: amlink21`

**Example:**
```bash
# Query parameter
curl "https://benriched.vercel.app/v1/enrich/company?api_key=amlink21" ...

# Authorization header (recommended)
curl -H "Authorization: Bearer amlink21" ...

# X-API-Key header
curl -H "X-API-Key: amlink21" ...
```

---

## Server-Sent Events (SSE) Streaming

The `/v1/enrich/company` endpoint supports real-time progress streaming using Server-Sent Events (SSE). This allows you to monitor the enrichment process as it happens, which is useful for long-running enrichments (30-40 seconds).

### Enabling Streaming

Add `?stream=true` to the request URL:

```bash
curl -N -X POST "https://benriched.vercel.app/v1/enrich/company?stream=true" \
  -H "Authorization: Bearer amlink21" \
  -H "Content-Type: application/json" \
  -d '{"domain": "lincolnpremiumpoultry.com"}'
```

Note: Use `-N` flag with curl to disable buffering and see events in real-time.

### Event Format

Each SSE event has this structure:

```
id: {unique-uuid}
event: {event-type}
data: {json-payload}

```

**Event Types:**
- `progress` - Stage started or completed
- `complete` - Enrichment finished successfully
- `error` - Error occurred during enrichment

### Event Payload

**Progress Event:**
```json
{
  "stage": "pass1_search",
  "message": "Web search complete",
  "status": "complete",
  "timestamp": "2026-01-25T10:30:02.000Z",
  "timing": {
    "elapsed_ms": 2000,
    "estimated_remaining_ms": 30000
  },
  "cost": {
    "usd": 0.0203
  },
  "data": {
    "company_name": "Example Inc",
    "parent_company": null
  }
}
```

**Complete Event:**
```json
{
  "stage": "complete",
  "message": "Enrichment complete",
  "status": "complete",
  "timestamp": "2026-01-25T10:30:25.000Z",
  "timing": {
    "elapsed_ms": 25000
  },
  "cost": {
    "usd": 0.0456
  },
  "data": {
    "id": "9a88c622-dd1d-4e35-9cd3-0cb5cc93543f",
    "domain": "example.com",
    "company_name": "Example Inc",
    ...
  }
}
```

**Error Event:**
```json
{
  "stage": "error",
  "message": "Failed to access domain",
  "status": "error",
  "timestamp": "2026-01-25T10:30:05.000Z",
  "timing": {
    "elapsed_ms": 5000
  }
}
```

### Enrichment Stages

The following 14 stages are emitted during enrichment:

| Stage | Description | Emits Cost? |
|-------|-------------|-------------|
| `cache_check` | Checking for cached company data | No |
| `domain_resolution` | Resolving domain to company website | Yes |
| `pass1_search` | Web search with Perplexity Sonar Pro | Yes |
| `deep_research` | Deep research queries (conditional, if outliers detected) | Yes |
| `url_selection` | Selecting URLs to scrape | No |
| `scraping` | Scraping with Firecrawl | Yes |
| `entity_validation` | Validating company identity | No |
| `linkedin_validation` | Extracting and validating LinkedIn profile | No |
| `pass2_analysis` | Content analysis with GPT-4o-mini | Yes |
| `data_estimation` | Estimating revenue and employee data | No |
| `parent_enrichment` | Parent company data inheritance (conditional) | No |
| `final_assembly` | Calculating costs and assembling data | No |
| `database_save` | Saving to database | No |
| `complete` | Enrichment finished | Yes (total) |

### JavaScript EventSource Example

```javascript
const domain = 'lincolnpremiumpoultry.com';
const eventSource = new EventSource(
  `https://benriched.vercel.app/v1/enrich/company?stream=true&domain=${domain}&api_key=amlink21`
);

// Listen for progress events
eventSource.addEventListener('progress', (event) => {
  const data = JSON.parse(event.data);

  console.log(`[${data.stage}] ${data.message}`);
  console.log(`⏱️  Elapsed: ${data.timing.elapsed_ms}ms`);

  if (data.cost) {
    console.log(`💰 Cost: $${data.cost.usd.toFixed(4)}`);
  }

  // Update UI progress bar
  updateProgressBar(data.stage, data.timing.elapsed_ms);
});

// Listen for completion
eventSource.addEventListener('complete', (event) => {
  const data = JSON.parse(event.data);

  console.log('✅ Enrichment complete!');
  console.log(`Total cost: $${data.cost.usd.toFixed(4)}`);
  console.log('Data:', data.data);

  // Display results in UI
  displayResults(data.data);

  // Close connection
  eventSource.close();
});

// Listen for errors
eventSource.addEventListener('error', (event) => {
  const data = JSON.parse(event.data);

  console.error(`❌ ${data.message}`);

  // Close connection
  eventSource.close();
});

// Handle connection errors
eventSource.onerror = (error) => {
  console.error('SSE connection failed:', error);
  eventSource.close();
};
```

### React Streaming Example

```jsx
import { useEffect, useState } from 'react';

export function CompanyEnrichment({ domain, apiKey }) {
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState([]);
  const [result, setResult] = useState(null);
  const [cost, setCost] = useState(0);

  useEffect(() => {
    if (status !== 'enriching') return;

    const eventSource = new EventSource(
      `https://benriched.vercel.app/v1/enrich/company?stream=true&domain=${domain}&api_key=${apiKey}`
    );

    eventSource.addEventListener('progress', (event) => {
      const data = JSON.parse(event.data);
      setProgress((prev) => [...prev, data]);
      if (data.cost) setCost(data.cost.usd);
    });

    eventSource.addEventListener('complete', (event) => {
      const data = JSON.parse(event.data);
      setProgress((prev) => [...prev, data]);
      setResult(data.data);
      setCost(data.cost.usd);
      setStatus('complete');
      eventSource.close();
    });

    eventSource.addEventListener('error', (event) => {
      const data = JSON.parse(event.data);
      setProgress((prev) => [...prev, data]);
      setStatus('error');
      eventSource.close();
    });

    return () => eventSource.close();
  }, [status, domain, apiKey]);

  return (
    <div>
      <button
        onClick={() => setStatus('enriching')}
        disabled={status !== 'idle'}
      >
        {status === 'idle' ? 'Enrich' : status === 'enriching' ? 'Enriching...' : 'Done'}
      </button>

      <div className="progress">
        {progress.map((event, idx) => (
          <div key={idx} className={`event event-${event.status}`}>
            <strong>[{event.stage}]</strong> {event.message}
            {event.cost && <span> • ${event.cost.usd.toFixed(4)}</span>}
          </div>
        ))}
      </div>

      {result && (
        <div className="results">
          <h3>{result.company_name}</h3>
          <p>Revenue: {result.company_revenue}</p>
          <p>Employees: {result.company_size}</p>
        </div>
      )}
    </div>
  );
}
```

### cURL Streaming Example

```bash
# Stream enrichment progress in real-time
curl -N -X POST "https://benriched.vercel.app/v1/enrich/company?stream=true" \
  -H "Authorization: Bearer amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "lincolnpremiumpoultry.com",
    "hs_company_id": "123456"
  }'
```

Output (line by line as events arrive):
```
id: 550e8400-e29b-41d4-a716-446655440000
event: progress
data: {"stage":"cache_check","message":"Checking for cached data...","status":"started","timestamp":"2026-01-25T10:30:00.000Z","timing":{"elapsed_ms":0}}

id: 550e8400-e29b-41d4-a716-446655440001
event: progress
data: {"stage":"pass1_search","message":"Web search complete","status":"complete","timestamp":"2026-01-25T10:30:02.000Z","timing":{"elapsed_ms":2000},"cost":{"usd":0.0203}}

...

id: 550e8400-e29b-41d4-a716-446655440012
event: complete
data: {"stage":"complete","message":"Enrichment complete","status":"complete","timestamp":"2026-01-25T10:30:25.000Z","timing":{"elapsed_ms":25000},"cost":{"usd":0.0456},"data":{...}}
```

### Backwards Compatibility

**Important:** Streaming is completely optional and fully backwards compatible.

- Without `?stream=true`: Returns standard JSON response immediately (existing behavior)
- With `?stream=true`: Returns SSE stream with real-time progress updates
- Both modes share identical enrichment logic and produce identical final results

All existing API clients continue to work unchanged. Streaming is an opt-in feature.

---

## Endpoints

### 1. GET / (Root)
Returns API metadata and available endpoints.

**Request:**
```bash
curl https://benriched.vercel.app/
```

**Response:** `200 OK`
```json
{
  "name": "Benriched API",
  "version": "0.1.0",
  "description": "Company enrichment API service",
  "endpoints": {
    "v1": {
      "health": "GET /v1/health",
      "enrich_company": "POST /v1/enrich/company",
      "enrich_contact": "POST /v1/enrich/contact",
      "enrich_contact_by_id": "POST /v1/enrich/contact-by-id",
      "match_persona": "POST /v1/match/persona",
      "research_contact": "POST /v1/research/contact",
      "generate_email_sequence": "POST /v1/generate/email-sequence"
    },
    "legacy": {
      "health": "GET /health (use /v1/health)",
      "enrich": "POST /enrich (use /v1/enrich/company)",
      "persona": "POST /persona (use /v1/match/persona)",
      "research_contact": "POST /research/contact (use /v1/research/contact)",
      "outreach_email_sequence": "POST /outreach/email-sequence (use /v1/generate/email-sequence)"
    }
  },
  "migration": "Legacy endpoints are supported indefinitely. Consider migrating to v1 endpoints."
}
```

**Status Codes:**
- `200 OK` - Success

---

### 2. GET /v1/health
Health check endpoint. No authentication required.

**Request:**
```bash
curl https://benriched.vercel.app/v1/health
```

**Response:** `200 OK`
```json
{
  "status": "ok",
  "timestamp": "2026-01-25T10:29:45.329Z",
  "version": "0.1.0"
}
```

**Status Codes:**
- `200 OK` - Service is healthy

---

### 3. POST /v1/enrich/company
Enrich a company by domain with detailed business intelligence data.

**Streaming Support:** This endpoint supports real-time progress streaming via Server-Sent Events. Add `?stream=true` to enable. See [Server-Sent Events (SSE) Streaming](#server-sent-events-sse-streaming) section for details.

**Request:**
```bash
# Standard (non-streaming) request
curl -X POST https://benriched.vercel.app/v1/enrich/company \
  -H "Authorization: Bearer amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "lincolnpremiumpoultry.com",
    "hs_company_id": "123456",
    "force_refresh": false
  }'

# Streaming request - see real-time progress
curl -N -X POST "https://benriched.vercel.app/v1/enrich/company?stream=true" \
  -H "Authorization: Bearer amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "lincolnpremiumpoultry.com",
    "hs_company_id": "123456"
  }'
```

**Request Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `domain` | string | Yes | Company domain (e.g., "example.com", "https://example.com", "www.example.com") |
| `hs_company_id` | string | No | HubSpot company ID for tracking and linking |
| `force_refresh` | boolean | No | Force re-enrichment, bypass cache (default: false) |
| `deep_research` | boolean | No | Trigger deep research pass for uncertain data (default: false) |
| `async` | boolean | No | Process asynchronously, return immediately (default: false) |

**Response:** `200 OK`
```json
{
  "success": true,
  "data": {
    "id": "9a88c622-dd1d-4e35-9cd3-0cb5cc93543f",
    "domain": "lincolnpremiumpoultry.com",
    "company_name": "Lincoln Premium Poultry",
    "website": "https://lincolnpremiumpoultry.com",
    "linkedin_url": "https://www.linkedin.com/company/lincoln-premium-poultry",
    "business_description": "Premium poultry producer specializing in high-quality chicken products for food service and retail distribution.",
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
    "last_enriched_at": "2026-01-15T09:47:08.551273+00:00"
  },
  "cached": false,
  "hs_company_id": "123456",
  "submitted_domain": "lincolnpremiumpoultry.com",
  "normalized_domain": "lincolnpremiumpoultry.com",
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
| `success` | boolean | Whether enrichment succeeded |
| `data` | object | Enriched company data |
| `cached` | boolean | Whether data came from cache |
| `hs_company_id` | string \| null | HubSpot company ID if provided |
| `cost` | object | Breakdown of API costs (AI tokens + Firecrawl credits) |

**Status Codes:**
- `200 OK` - Enrichment successful
- `400 Bad Request` - Missing required field (domain)
- `401 Unauthorized` - Missing or invalid API key
- `500 Internal Server Error` - Server error during processing

**Error Response:**
```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

**Performance:**
- **Cached hit**: ~100-200ms
- **Fresh enrichment**: ~30-40 seconds
- **With deep research**: +20-30 seconds

**Cost:**
- **Cached hit**: $0.00
- **Fresh enrichment**: ~$0.02-0.03
- **With deep research**: +$0.01-0.02

---

### 4. POST /v1/enrich/contact
Enrich contact information using ZoomInfo API.

**Request:**
```bash
curl -X POST https://benriched.vercel.app/v1/enrich/contact \
  -H "Authorization: Bearer amlink21" \
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

**Request Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `email` | string | Yes | Contact email address |
| `first_name` | string | No | Contact first name |
| `last_name` | string | No | Contact last name |
| `full_name` | string | No | Contact full name (alternative to first/last) |
| `job_title` | string | No | Contact job title |
| `company_name` | string | No | Contact company name |
| `hs_company_id` | string | No | HubSpot company ID for tracking |
| `hs_contact_id` | string | No | HubSpot contact ID for tracking |

**Response:** `200 OK`
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

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether enrichment succeeded |
| `data` | object | Enriched contact data |
| `was_cached` | boolean | Whether data came from ZoomInfo cache |
| `credits_used` | number | ZoomInfo credits used |
| `response_time_ms` | number | Response time in milliseconds |

**Status Codes:**
- `200 OK` - Contact enrichment successful
- `400 Bad Request` - Missing required field (email)
- `401 Unauthorized` - Missing or invalid API key
- `500 Internal Server Error` - ZoomInfo credentials not configured or API error

**Error Response:**
```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

---

### 5. POST /v1/enrich/contact-by-id
Enrich a contact using their ZoomInfo person ID. Useful for enriching contacts discovered via contact search where you have the ZoomInfo ID but not the email address.

**Request:**
```bash
curl -X POST https://benriched.vercel.app/v1/enrich/contact-by-id \
  -H "Authorization: Bearer amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "zoominfo_person_id": "123456789",
    "hs_contact_id": "789012",
    "hs_company_id": "456789",
    "force_refresh": false,
    "update_hubspot": true
  }'
```

**Request Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `zoominfo_person_id` | string | Yes | ZoomInfo person ID to enrich |
| `hs_contact_id` | string | No | HubSpot contact ID for tracking and updating |
| `hs_company_id` | string | No | HubSpot company ID for tracking |
| `force_refresh` | boolean | No | Force re-enrichment, bypass cache (default: false) |
| `update_hubspot` | boolean | No | If true and hs_contact_id provided, update HubSpot contact with enriched data (default: false) |

**Response:** `200 OK`
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
    "direct_phone": "(555) 123-4567",
    "cell_phone": "(248) 835-7718",
    "linked_profile_url": "https://www.linkedin.com/in/nellie-arroyo-664877105",
    "zoominfo_person_id": "123456789",
    "hubspot_contact_id": "789012",
    "hubspot_company_id": "456789",
    "created_at": "2026-01-21T08:58:17.490467+00:00",
    "updated_at": "2026-01-21T08:58:17.490467+00:00"
  },
  "was_cached": false,
  "credits_used": 1,
  "response_time_ms": 1315,
  "hubspot_updated": true
}
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether enrichment succeeded |
| `data` | object | Enriched contact data |
| `was_cached` | boolean | Whether data came from database cache |
| `credits_used` | number | ZoomInfo credits used (0 if cached) |
| `response_time_ms` | number | Response time in milliseconds |
| `hubspot_updated` | boolean | Whether HubSpot contact was updated (only present if `update_hubspot: true`) |
| `error` | string | Error message if enrichment partially failed |

**HubSpot Field Mappings:**

When `update_hubspot: true` is set and `hs_contact_id` is provided, the following fields are pushed to HubSpot:

| Our Field | HubSpot Property |
|-----------|------------------|
| `first_name` | `firstname` |
| `last_name` | `lastname` |
| `full_name` | `full_name` |
| `email_address` | `email` |
| `job_title` | `jobtitle` |
| `direct_phone` | `phone_direct__c` |
| `cell_phone` | `mobilephone` |
| `linked_profile_url` | `boomerang_linkedin_url` |
| `zoominfo_person_id` | `zoom_individual_id` |

**Source Attribution (always set):**

| HubSpot Property | Value | Description |
|------------------|-------|-------------|
| `hs_analytics_source` | `OFFLINE` | Original source (ZoomInfo = offline) |
| `hs_lead_status` | `NEW` | Lead status for new contacts |
| `lifecyclestage` | `lead` | Lifecycle stage |

**Status Codes:**
- `200 OK` - Contact enrichment successful
- `400 Bad Request` - Missing required field (zoominfo_person_id)
- `401 Unauthorized` - Missing or invalid API key
- `500 Internal Server Error` - ZoomInfo credentials not configured or API error

**Error Response:**
```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

---

### 6. POST /v1/match/persona
Match a job title to a sales persona for targeting and personalization.

**Request:**
```bash
curl -X POST https://benriched.vercel.app/v1/match/persona \
  -H "Authorization: Bearer amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Food Safety Manager"
  }'
```

**Request Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Job title to classify/match |

**Response:** `200 OK`
```json
{
  "success": true,
  "data": {
    "title": "Food Safety Manager",
    "matched_from": "ai",
    "primary_persona": {
      "id": "7000a515-0f02-4102-a861-537b37acc07f",
      "persona_title": "Quality & EHS",
      "description": "Quality & EHS personnel work alongside other departments to ensure product safety and regulatory compliance...",
      "responsibilities": "Oversight of food safety protocols, quality assurance, regulatory compliance, staff training",
      "top_priorities": "Ensuring food safety, reducing contamination risk, regulatory compliance",
      "key_terms": "Food safety, HACCP, SQF certification, sanitation, recalls"
    },
    "secondary_persona": null,
    "confidence": "high",
    "tier": "Tier 2 (Manager / Recommender)",
    "normalized_title": "Food Safety Manager"
  }
}
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether matching succeeded |
| `data` | object | Matched persona data |
| `data.matched_from` | string | Source of match ("ai" or "database") |
| `data.primary_persona` | object | Primary matched persona with ID and details |
| `data.secondary_persona` | object \| null | Secondary matched persona if available |
| `data.confidence` | string | Confidence level ("high", "medium", "low") |
| `data.tier` | string | Decision-maker tier classification |

**Status Codes:**
- `200 OK` - Persona matching successful
- `400 Bad Request` - Missing required field (title)
- `401 Unauthorized` - Missing or invalid API key
- `500 Internal Server Error` - Server error during matching

**Error Response:**
```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

---

### 7. POST /v1/research/contact
Research a prospect for outbound sales personalization using Perplexity web search.

**Request:**
```bash
curl -X POST https://benriched.vercel.app/v1/research/contact \
  -H "Authorization: Bearer amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "prospect_name": "Jessica Packard",
    "company_name": "Timeero",
    "linkedin_url": "https://www.linkedin.com/in/jessica-packard"
  }'
```

**Request Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prospect_name` | string | Yes | Full name of the prospect |
| `company_name` | string | Yes | Company name |
| `linkedin_url` | string | No | LinkedIn profile URL for additional context |

**Response:** `200 OK`
```json
{
  "success": true,
  "data": {
    "prospect_name": "Jessica Packard",
    "company_name": "Timeero",
    "research_summary": "Jessica Packard is a key decision-maker at Timeero, a workforce management software company. She leads product development and strategy, focusing on time tracking and scheduling solutions...",
    "key_insights": [
      "Recently led company expansion into European markets",
      "Published thought leadership on remote workforce management",
      "Active in industry conferences and speaking engagements",
      "Focuses on customer success and retention strategies"
    ],
    "personalization_angles": [
      "Reference recent product announcements to show market awareness",
      "Emphasize integration capabilities with their existing tech stack",
      "Highlight similar companies in their vertical that benefit from the solution",
      "Focus on workforce efficiency improvements"
    ],
    "recommended_approach": "Personalized outreach focusing on her recent speaking engagement at WorkTech Summit and emphasizing product integrations with Timeero's platform."
  },
  "metadata": {
    "prospect_name": "Jessica Packard",
    "company_name": "Timeero",
    "linkedin_url": "https://www.linkedin.com/in/jessica-packard",
    "tokens": {
      "input": 450,
      "output": 320,
      "total": 770
    },
    "cost_usd": 0.00924,
    "response_time_ms": 2500
  }
}
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether research succeeded |
| `data` | object | Research findings and insights |
| `data.research_summary` | string | Summary of prospect's background and role |
| `data.key_insights` | array | Array of key insights about the prospect |
| `data.personalization_angles` | array | Suggested angles for outbound outreach |
| `data.recommended_approach` | string | Recommended sales approach |
| `metadata` | object | Request metadata (tokens, cost, timing) |

**Status Codes:**
- `200 OK` - Research successful
- `400 Bad Request` - Missing required fields (prospect_name, company_name)
- `401 Unauthorized` - Missing or invalid API key
- `500 Internal Server Error` - Perplexity API error or not configured

**Error Response:**
```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

---

### 8. POST /v1/generate/email-sequence
Generate personalized email sequences for outbound sales campaigns.

**Request:**
```bash
curl -X POST https://benriched.vercel.app/v1/generate/email-sequence \
  -H "Authorization: Bearer amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "prospect_name": "Jessica Packard",
    "company_name": "Timeero",
    "title": "VP of Product",
    "industry": "HR Tech",
    "first_name": "Jessica",
    "last_name": "Packard"
  }'
```

**Request Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `first_name` | string | Conditional | First name (required if full_name not provided) |
| `last_name` | string | Conditional | Last name (required if full_name not provided) |
| `full_name` | string | Conditional | Full name (alternative to first/last) |
| `company_name` | string | Yes | Company name of prospect |
| `title` | string | Yes | Job title of prospect |
| `industry` | string | No | Industry classification |
| `known_trigger` | string | No | Recent company event or news trigger |
| `stated_pains` | string | No | Known pain points or challenges |

**Response:** `200 OK`
```json
{
  "success": true,
  "data": {
    "prospect_name": "Jessica Packard",
    "company_name": "Timeero",
    "title": "VP of Product",
    "sequences": [
      {
        "email_number": 1,
        "subject": "Quick question about Timeero's product roadmap",
        "body": "Hi Jessica,\n\nI noticed Timeero recently announced expansion into the European market. That's impressive growth.\n\nI work with companies like yours that are scaling their workforce management solutions...",
        "days_after_previous": 0,
        "type": "opener"
      },
      {
        "email_number": 2,
        "subject": "RE: Quick question about Timeero's product roadmap",
        "body": "Hi Jessica,\n\nJust wanted to follow up on my previous message. I have a specific idea related to your recent product announcements that I think could be valuable...",
        "days_after_previous": 3,
        "type": "follow_up"
      },
      {
        "email_number": 3,
        "subject": "One more idea for Timeero's efficiency gains",
        "body": "Hi Jessica,\n\nFinal thought - I found 3 companies in your space that are seeing significant improvements in deployment speed...",
        "days_after_previous": 5,
        "type": "final_touch"
      }
    ],
    "campaign_strategy": "Focus on recent company growth, emphasize integration capabilities, reference industry events for credibility.",
    "timing_notes": "Optimal send times based on Jessica's industry and title typically between 10am-2pm on Tuesday/Wednesday."
  },
  "response_time_ms": 3200
}
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether generation succeeded |
| `data` | object | Generated email sequence |
| `data.sequences` | array | Array of email templates in sequence |
| `data.sequences[].email_number` | number | Email position in sequence (1-3) |
| `data.sequences[].subject` | string | Email subject line |
| `data.sequences[].body` | string | Email body text |
| `data.sequences[].days_after_previous` | number | Days to wait before sending this email |
| `data.sequences[].type` | string | Email type ("opener", "follow_up", "final_touch") |
| `data.campaign_strategy` | string | Overall strategy for the campaign |
| `data.timing_notes` | string | Recommended send time windows |
| `response_time_ms` | number | Response time in milliseconds |

**Status Codes:**
- `200 OK` - Email sequence generated successfully
- `400 Bad Request` - Missing required fields
- `401 Unauthorized` - Missing or invalid API key
- `500 Internal Server Error` - Email generation service error

**Error Response:**
```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

---

## Legacy Endpoints

All legacy endpoints are supported indefinitely and respond identically to their v1 counterparts:

| Legacy Endpoint | Equivalent v1 Endpoint |
|----------------|----------------------|
| `POST /enrich` | `POST /v1/enrich/company` |
| `POST /enrich/contact` | `POST /v1/enrich/contact` |
| `POST /enrich/contact-by-id` | `POST /v1/enrich/contact-by-id` |
| `POST /persona` | `POST /v1/match/persona` |
| `POST /research/contact` | `POST /v1/research/contact` |
| `POST /outreach/email-sequence` | `POST /v1/generate/email-sequence` |
| `GET /health` | `GET /v1/health` |

Legacy endpoints accept the same request/response formats as their v1 equivalents.

---

## Error Handling

### Error Response Format

All error responses follow this format:

```json
{
  "success": false,
  "error": "Human-readable error message"
}
```

### Common Error Codes

| Status Code | Meaning | Common Causes |
|------------|---------|--------------|
| `400 Bad Request` | Request validation failed | Missing required field, invalid data format |
| `401 Unauthorized` | Authentication failed | Missing API key, invalid key, wrong key format |
| `500 Internal Server Error` | Server-side error | API service unavailable, external API failure, database error |

### Example Error Responses

**Missing API Key:**
```json
{
  "error": "Missing API key. Use ?api_key=<key> or Authorization: Bearer <key>"
}
```

**Missing Required Field:**
```json
{
  "error": "Missing required field: domain"
}
```

**Invalid API Key:**
```json
{
  "error": "Invalid API key"
}
```

**Server Error:**
```json
{
  "success": false,
  "error": "AI Gateway API key not configured"
}
```

---

## Rate Limiting

Currently implemented in local development:
- **Window**: 60 seconds
- **Max requests**: 10 per window
- **Identifier**: `X-Client-ID` header or API key

Rate limiting for Vercel production can be added using Upstash or Vercel Edge Config.

---

## Pagination & Filtering

Currently, pagination and filtering are not supported. All endpoints return complete data or error responses.

---

## Versioning

The API uses URL-based versioning:
- **Current version**: `/v1/`
- **Legacy**: `/` (endpoints at root level)

All v1 endpoints are stable and production-ready. Legacy endpoints are maintained for backwards compatibility.

---

## Examples

### Complete cURL Examples

**Enrich a company:**
```bash
curl -X POST https://benriched.vercel.app/v1/enrich/company \
  -H "Authorization: Bearer amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "lincolnpremiumpoultry.com",
    "hs_company_id": "123456"
  }' | jq .
```

**Enrich a contact:**
```bash
curl -X POST https://benriched.vercel.app/v1/enrich/contact \
  -H "Authorization: Bearer amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "nellie@oishii.com",
    "first_name": "Nellie",
    "last_name": "Arroyo",
    "job_title": "General Manager"
  }' | jq .
```

**Enrich a contact by ZoomInfo ID (with HubSpot update):**
```bash
curl -X POST https://benriched.vercel.app/v1/enrich/contact-by-id \
  -H "Authorization: Bearer amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "zoominfo_person_id": "123456789",
    "hs_contact_id": "789012",
    "update_hubspot": true
  }' | jq .
```

**Match a persona:**
```bash
curl -X POST https://benriched.vercel.app/v1/match/persona?api_key=amlink21 \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Food Safety Manager"
  }' | jq .
```

**Research a prospect:**
```bash
curl -X POST https://benriched.vercel.app/v1/research/contact \
  -H "X-API-Key: amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "prospect_name": "Jessica Packard",
    "company_name": "Timeero"
  }' | jq .
```

**Generate email sequence:**
```bash
curl -X POST https://benriched.vercel.app/v1/generate/email-sequence \
  -H "Authorization: Bearer amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "first_name": "Jessica",
    "last_name": "Packard",
    "company_name": "Timeero",
    "title": "VP of Product"
  }' | jq .
```

**Check health:**
```bash
curl https://benriched.vercel.app/v1/health | jq .
```

---

## Data Types

### Company Enrichment Response Fields

- `company_name`: String - Official company name
- `website`: String - Company website URL
- `linkedin_url`: String - LinkedIn company page URL
- `business_description`: String - 2-4 sentence description of business
- `company_size`: String - Employee count band (e.g., "1,001-5,000 Employees")
- `company_revenue`: String - Revenue band (e.g., "500M-1B")
- `city`: String - Headquarters city
- `state`: String - Headquarters state/province
- `hq_country`: String - 2-letter ISO country code
- `is_us_hq`: Boolean - Whether HQ is in US
- `is_us_subsidiary`: Boolean - Whether company has US operations
- `naics_codes_6_digit`: Array of objects - Industry classification
- `target_icp`: Boolean - Whether company matches target ICP criteria
- `quality`: Object - Confidence metrics for each field

### Contact Enrichment Response Fields

- `email_address`: String - Contact email
- `first_name`: String - First name
- `last_name`: String - Last name
- `full_name`: String - Full name
- `job_title`: String - Job title
- `direct_phone`: String - Direct phone number
- `cell_phone`: String - Mobile phone number
- `linked_profile_url`: String - LinkedIn profile URL
- `zoominfo_person_id`: String - ZoomInfo person ID
- `hubspot_contact_id`: String - HubSpot contact ID if provided
- `hubspot_company_id`: String - HubSpot company ID if provided

### Persona Response Fields

- `title`: String - Original job title
- `normalized_title`: String - Normalized version of title
- `primary_persona`: Object - Matched persona with details
- `confidence`: String - Match confidence level
- `tier`: String - Decision-maker tier classification

---

## Support

For issues or questions:
1. Check the [project documentation](../claude.md)
2. Review the error message and error codes section above
3. Verify your API key and authentication method
4. Check that required fields are present and valid

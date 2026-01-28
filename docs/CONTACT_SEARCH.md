# Contact Search Endpoint

## Overview

The Contact Search endpoint searches ZoomInfo for contacts at a company, filters and tier-tags them based on ICP criteria, checks HubSpot for existing contacts, and optionally enriches them with full contact details.

**Endpoints:**
- `POST /v1/search/contacts` (new)
- `POST /search/contacts` (legacy alias)

## Request Format

```json
{
  "company_domain": "finlays.net",        // Required (or company_name)
  "company_name": "Finlays",              // Required (or company_domain)
  "management_levels": ["C Level Exec", "VP Level Exec", "Director", "Manager"],  // Optional, these are defaults
  "job_titles": ["Plant Manager"],        // Optional - overrides ICP filter if provided
  "max_results": 25,                      // Optional, default 25, max 100
  "page": 1,                              // Optional, default 1
  "auto_paginate": false,                 // Optional - fetch ALL pages in one call
  "enrich_contacts": false,               // Optional - spend credits to get email/phone
  "skip_cached": false,                   // Optional - re-enrich even if in DB
  "require_contact_data": true,           // Optional, default true - filter out unreachable contacts
  "use_icp_filter": true,                 // Optional, default true - filter by ICP keywords
  "check_hubspot": true,                  // Optional, default true - check HubSpot for existing contacts
  "hs_company_id": "12345"                // Optional - HubSpot company ID for tracking
}
```

## Response Format

```json
{
  "success": true,
  "data": {
    "company": {
      "id": "uuid",
      "domain": "finlays.net",
      "company_name": "Finlays"
    },
    "contacts": [
      {
        "first_name": "John",
        "last_name": "Smith",
        "full_name": "John Smith",
        "job_title": "Director of Operations",
        "zoominfo_person_id": "123456",
        "contact_accuracy_score": 95,
        "has_email": true,
        "has_supplemental_email": false,
        "has_direct_phone": true,
        "has_mobile_phone": true,
        "icp_tier": "Tier 3 (Strong Owner)",
        "icp_tier_rank": 3,
        "icp_matched_title": "Director of Operations",
        "in_hubspot": false,
        "hs_contact_id": null
      }
    ],
    "pagination": {
      "page": 1,
      "page_size": 25,
      "total_results": 50,
      "total_pages": 2,
      "has_more": true
    }
  },
  "metadata": {
    "search_filters": {
      "management_levels": ["C Level Exec", "VP Level Exec", "Director", "Manager"],
      "job_titles": null,
      "icp_keyword_filter": true
    },
    "found_count": 35,
    "no_contact_data_filtered_count": 15,
    "tier_tagged_count": 35,
    "ai_classified_count": 5,
    "hubspot_checked_count": 35,
    "hubspot_matched_count": 10,
    "failed_count": 0
  },
  "cost": {
    "search_credits": 1,
    "enrich_credits": 0,
    "total_credits": 1
  },
  "response_time_ms": 8500
}
```

---

## Processing Pipeline

### Stage 1: ZoomInfo Contact Search

**API Call:** `POST https://api.zoominfo.com/search/contact`

**Filters Applied:**
- `companyWebsite` or `companyName` from request
- `managementLevel`: Default "C Level Exec,VP Level Exec,Director,Manager"
- `jobTitle`: ICP keywords OR custom titles from request

**ICP Keywords (default filter):**
```
Quality, Operations, Food Safety, Safety, IT, Production, EHS, Compliance,
Supply Chain, Plant, Regulatory, Manufacturing, Automation, Maintenance,
Continuous Improvement, FSQA, Digital Transformation
```

**Cost:** 1 search credit per API call

**Auto-Pagination:** If `auto_paginate: true`, fetches all pages until no more results.

---

### Stage 2: Contact Data Filtering

**Purpose:** Remove contacts that can't be reached (no email or phone).

**Logic:**
```
Keep contact IF:
  hasEmail = true OR
  hasSupplementalEmail = true OR
  hasDirectPhone = true OR
  hasMobilePhone = true
```

**Disable:** Set `require_contact_data: false` to skip this filter.

**Metadata:** `no_contact_data_filtered_count` shows how many were removed.

---

### Stage 3: Company Lookup

Looks up the company in the `companies` table by domain to get the internal `company_id` for linking contacts.

---

### Stage 4: HubSpot Pre-Check

**Purpose:** Identify contacts already in HubSpot CRM to avoid duplicate enrichment.

**API Call:** `POST https://api.hubapi.com/crm/v3/objects/contacts/search`

**Batching:** 5 contacts per API call (HubSpot max filterGroups)

**Matching:** Firstname + Lastname (case-insensitive)

**Result:** Each contact gets:
- `in_hubspot: true/false`
- `hs_contact_id: "12345"` (if found)

**Disable:** Set `check_hubspot: false` to skip.

---

### Stage 5: Tier Classification

Each contact's job title is classified into a tier using a 3-layer approach:

#### Layer 1: Database Match (Exact)
Check if title exists exactly in `titles` table (case-insensitive).

#### Layer 2: Database Match (Fuzzy)
Check if title contains or is contained by any DB title.
Also tries abbreviation expansion first:
```
CEO → Chief Executive Officer
CFO → Chief Financial Officer
VP → Vice President
IT → Information Technology
QA → Quality Assurance
... (20+ mappings)
```

#### Layer 3: AI Fallback
If still Tier 0, call GPT-4o-mini for classification:
- Cost: ~$0.0001-0.0005 per call
- Returns tier + normalized title

**AI Learning:** After AI classification, the title is saved to the `titles` table for future DB matching:
- Saves: title, tier, normalized_title, primary_persona (inferred from keywords)
- Note: "AI-classified via contact search"

**Tier Definitions:**
| Tier | Label | Description |
|------|-------|-------------|
| 4 | Ultimate | C-Suite, President, Owner, Founder |
| 3 | Strong Owner | VP, Director, Plant Manager, General Manager |
| 2 | Manager/Recommender | Manager-level, Team Lead, Supervisor |
| 1 | IC/Advisor | Individual Contributor, Specialist, Analyst |
| 0 | Unknown | Unclassified |

---

### Stage 6: Sorting

Contacts are sorted by `icp_tier_rank` descending (highest tier first).

---

### Stage 7: Optional Enrichment

**Triggered by:** `enrich_contacts: true`

**Skips:**
- Contacts already in HubSpot (unless `check_hubspot: false`)
- Contacts already in DB (unless `skip_cached: true`)

**API Call:** `POST https://api.zoominfo.com/enrich/contact` (batch by person ID)

**Returns:**
- email_address
- direct_phone, cell_phone
- linked_profile_url (LinkedIn)
- Full company info

**Cost:** 1 credit per contact enriched

**Storage:** Enriched contacts saved to `contacts` table.

---

### Stage 8: Request Logging

Saves to `enrichment_requests` table:
- Domain, company_id
- Request type: "contact-search"
- Cost (credits used)
- Response time
- Raw API responses

---

## Persona Inference

When AI classifies a title, a persona is inferred from keywords:

| Keywords | Persona |
|----------|---------|
| quality, food safety, compliance, regulatory, audit | Quality & EHS |
| information technology, digital, software, systems | IT |
| supply chain, procurement, logistics, warehouse | Supply Chain & Procurement |
| engineering, continuous improvement, lean | Engineering & Continuous Improvement |
| maintenance, facilities, reliability | Maintenance |
| plant manager, site manager, general manager | Plant Leadership |
| production, operations, manufacturing | Production |
| chief, ceo, cfo, president, owner | Corporate Management |

---

## Cost Summary

| Action | Credits |
|--------|---------|
| Search (per API call) | 1 |
| Enrich (per contact) | 1 |
| AI Classification | ~$0.0001-0.0005 each |

**Typical Search (no enrich):** 1 credit
**Search + Enrich 25 contacts:** 1 + 25 = 26 credits

---

## Examples

### Basic Search
```bash
curl -X POST "https://benriched.vercel.app/v1/search/contacts?api_key=amlink21" \
  -H "Content-Type: application/json" \
  -d '{"company_domain": "finlays.net"}'
```

### Search with Custom Titles
```bash
curl -X POST "https://benriched.vercel.app/v1/search/contacts?api_key=amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "company_domain": "finlays.net",
    "job_titles": ["Plant Manager", "Quality Director"],
    "max_results": 50
  }'
```

### Fetch All Pages
```bash
curl -X POST "https://benriched.vercel.app/v1/search/contacts?api_key=amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "company_domain": "finlays.net",
    "auto_paginate": true,
    "max_results": 100
  }'
```

### Search + Enrich
```bash
curl -X POST "https://benriched.vercel.app/v1/search/contacts?api_key=amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "company_domain": "finlays.net",
    "enrich_contacts": true,
    "max_results": 10
  }'
```

---

## Self-Learning System

The endpoint improves itself over time:

1. **First search for "Director of Digital Agriculture":**
   - No DB match → AI classifies → Tier 3
   - **Saves to titles table** with persona

2. **Second search with same title:**
   - DB match found → Tier 3
   - **No AI call needed**

This reduces:
- AI costs (~$0.0003 saved per learned title)
- Latency (50ms DB lookup vs 500-1000ms AI call)

View learned titles:
```sql
SELECT title, tier, persona_title
FROM titles t
LEFT JOIN personas p ON t.primary_persona = p.id
WHERE notes = 'AI-classified via contact search'
ORDER BY created_at DESC;
```

---

## Error Handling

| Error | Response |
|-------|----------|
| Missing company_domain/company_name | 400: "Missing required field" |
| ZoomInfo auth failure | 500: "ZoomInfo credentials not configured" |
| ZoomInfo API error | 500: Error message from API |
| Partial enrichment failure | 200: Success with `errors` array |

---

## Files

| File | Purpose |
|------|---------|
| `src/lib/contact-search.ts` | Core logic: search, filter, tier, enrich |
| `src/lib/zoominfo-auth.ts` | JWT token caching for ZoomInfo |
| `src/lib/tier.ts` | AI tier classification |
| `src/routes/v1/search/contacts.ts` | Route handler |
| `src/routes/legacy/aliases.ts` | Legacy `/search/contacts` route |

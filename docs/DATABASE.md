# Database Schema Reference

This document describes the Benriched database schema, data types, and common queries.

## Table of Contents

1. [Database Overview](#database-overview)
2. [Tables](#tables)
3. [Common Queries](#common-queries)
4. [Data Types Reference](#data-types-reference)

---

## Database Overview

**Database System:** Supabase (PostgreSQL)

**Connection String Format:**
```
postgresql://user:password@host:port/database
```

**Access via Supabase Console:**
1. Log in to Supabase dashboard
2. Select your project
3. Go to "SQL Editor" for direct SQL access
4. Or use "Database" section to browse tables

---

## Tables

### 1. companies Table

**Primary Table:** Stores enriched company data

**Columns:**

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | UUID | NO | Primary key (auto-generated) |
| `domain` | TEXT | NO | Company domain (unique key) |
| `company_name` | TEXT | YES | Official company name |
| `website` | TEXT | YES | Company website URL |
| `linkedin_url` | TEXT | YES | LinkedIn company page URL |
| `business_description` | TEXT | YES | 2-4 sentence description |
| `company_size` | TEXT | YES | Employee band (e.g., "51-200 Employees") |
| `company_revenue` | TEXT | YES | Revenue band (e.g., "25M-75M") |
| `city` | TEXT | YES | HQ city |
| `state` | TEXT | YES | HQ state/province |
| `hq_country` | TEXT | YES | 2-letter ISO country code |
| `is_us_hq` | BOOLEAN | YES | True if global HQ is in US |
| `is_us_subsidiary` | BOOLEAN | YES | True if has US operations or US parent |
| `naics_codes_6_digit` | JSONB | YES | Array of {code, description} objects |
| `naics_codes_csv` | TEXT | YES | Comma-separated NAICS codes |
| `target_icp` | BOOLEAN | YES | Matches target ICP criteria |
| `target_icp_matches` | JSONB | YES | Array of matching NAICS codes |
| `source_urls` | JSONB | YES | Array of URLs used for enrichment |
| `quality` | JSONB | YES | Quality metrics for each field |
| `performance_metrics` | JSONB | YES | Performance data (pass1_ms, scraping_ms, etc.) |
| `parent_company_name` | TEXT | YES | Parent company name (cached) |
| `parent_company_domain` | TEXT | YES | Parent company domain |
| `inherited_revenue` | BOOLEAN | YES | True if revenue inherited from parent |
| `inherited_size` | BOOLEAN | YES | True if size inherited from parent |
| `created_at` | TIMESTAMP | NO | Record creation time |
| `updated_at` | TIMESTAMP | NO | Last update time |
| `last_enriched_at` | TIMESTAMP | YES | Last enrichment time |

**Indexes:**
- `domain` (unique, for fast lookups)
- `target_icp` (for filtering ICP matches)
- `created_at` (for time-based queries)

**Creation SQL:**
```sql
CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT UNIQUE NOT NULL,
  company_name TEXT,
  website TEXT,
  linkedin_url TEXT,
  business_description TEXT,
  company_size TEXT,
  company_revenue TEXT,
  city TEXT,
  state TEXT,
  hq_country TEXT,
  is_us_hq BOOLEAN,
  is_us_subsidiary BOOLEAN,
  naics_codes_6_digit JSONB,
  naics_codes_csv TEXT,
  target_icp BOOLEAN,
  target_icp_matches JSONB,
  source_urls JSONB,
  quality JSONB,
  performance_metrics JSONB,
  parent_company_name TEXT,
  parent_company_domain TEXT,
  inherited_revenue BOOLEAN,
  inherited_size BOOLEAN,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_enriched_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_companies_domain ON companies(domain);
CREATE INDEX idx_companies_target_icp ON companies(target_icp);
CREATE INDEX idx_companies_created_at ON companies(created_at);
```

---

### 2. enrichment_requests Table

**Purpose:** Log all enrichment requests for analytics and cost tracking

**Columns:**

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | UUID | NO | Primary key |
| `hs_company_id` | TEXT | NO | HubSpot company ID or generated ID |
| `domain` | TEXT | NO | Domain enriched |
| `company_id` | UUID | YES | Foreign key to companies table |
| `request_source` | TEXT | YES | "hubspot" or "api" |
| `request_type` | TEXT | YES | "enrichment", "cached", "contact-enrich", "contact-cached" |
| `was_cached` | BOOLEAN | YES | True if returned cached data |
| `cost_usd` | DECIMAL | YES | Total cost in USD |
| `response_time_ms` | INTEGER | YES | Response time in milliseconds |
| `raw_api_responses` | JSONB | YES | Raw responses from all API calls |
| `enrichment_cost` | JSONB | YES | Detailed cost breakdown (ai, firecrawl, total) |
| `created_at` | TIMESTAMP | NO | Request timestamp |

**Indexes:**
- `hs_company_id` (for HubSpot lookups)
- `domain` (for domain-based queries)
- `created_at` (for time-based analytics)

**Creation SQL:**
```sql
CREATE TABLE enrichment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hs_company_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  company_id UUID REFERENCES companies(id),
  request_source TEXT,
  request_type TEXT,
  was_cached BOOLEAN,
  cost_usd DECIMAL,
  response_time_ms INTEGER,
  raw_api_responses JSONB,
  enrichment_cost JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_enrichment_requests_hs_company_id ON enrichment_requests(hs_company_id);
CREATE INDEX idx_enrichment_requests_domain ON enrichment_requests(domain);
CREATE INDEX idx_enrichment_requests_created_at ON enrichment_requests(created_at);
```

---

### 3. contacts Table

**Purpose:** Store enriched contact information from ZoomInfo

**Columns:**

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | UUID | NO | Primary key |
| `hubspot_contact_id` | TEXT | YES | HubSpot contact ID |
| `hubspot_company_id` | TEXT | YES | HubSpot company ID |
| `company_id` | UUID | YES | Foreign key to companies table |
| `email_address` | TEXT | NO | Email (unique) |
| `first_name` | TEXT | YES | First name |
| `last_name` | TEXT | YES | Last name |
| `full_name` | TEXT | YES | Full name |
| `job_title` | TEXT | YES | Job title |
| `direct_phone` | TEXT | YES | Direct phone |
| `cell_phone` | TEXT | YES | Mobile phone |
| `linked_profile_url` | TEXT | YES | LinkedIn URL |
| `created_at` | TIMESTAMP | NO | Creation time |
| `updated_at` | TIMESTAMP | NO | Last update time |

**Indexes:**
- `email_address` (unique, for lookups)
- `hubspot_contact_id` (for HubSpot sync)

**Creation SQL:**
```sql
CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hubspot_contact_id TEXT,
  hubspot_company_id TEXT,
  company_id UUID REFERENCES companies(id),
  email_address TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  full_name TEXT,
  job_title TEXT,
  direct_phone TEXT,
  cell_phone TEXT,
  linked_profile_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_contacts_email ON contacts(email_address);
CREATE INDEX idx_contacts_hubspot_id ON contacts(hubspot_contact_id);
```

---

## Common Queries

### Cache Lookups

**Check if company cached by domain:**
```sql
SELECT * FROM companies WHERE domain = 'lincolnpremiumpoultry.com';
```

**Find all cached companies:**
```sql
SELECT domain, company_name, created_at
FROM companies
ORDER BY created_at DESC
LIMIT 50;
```

### Request Logging

**Log enrichment request:**
```sql
INSERT INTO enrichment_requests
(hs_company_id, domain, company_id, request_source, request_type, was_cached, cost_usd, response_time_ms, enrichment_cost)
VALUES
('123456', 'example.com', 'uuid-here', 'api', 'enrichment', false, 0.0456, 7234, '{"ai": {...}, "firecrawl": {...}, "total": {...}}');
```

**View recent enrichments:**
```sql
SELECT
  domain,
  request_type,
  was_cached,
  cost_usd,
  response_time_ms,
  created_at
FROM enrichment_requests
ORDER BY created_at DESC
LIMIT 20;
```

### Parent Company Lookups

**Find parent company:**
```sql
SELECT id, domain, company_name, company_revenue, company_size
FROM companies
WHERE domain = 'generalmills.com';
```

**Find companies with inherited data:**
```sql
SELECT
  domain,
  company_name,
  parent_company_name,
  inherited_revenue,
  inherited_size
FROM companies
WHERE inherited_revenue = true OR inherited_size = true;
```

### ICP Matching

**Find all ICP-matching companies:**
```sql
SELECT
  domain,
  company_name,
  company_revenue,
  company_size,
  hq_country
FROM companies
WHERE target_icp = true
ORDER BY created_at DESC;
```

**Count ICP matches by country:**
```sql
SELECT
  hq_country,
  COUNT(*) as count
FROM companies
WHERE target_icp = true
GROUP BY hq_country
ORDER BY count DESC;
```

**Find companies matching specific NAICS code:**
```sql
SELECT
  domain,
  company_name,
  naics_codes_csv
FROM companies
WHERE naics_codes_csv LIKE '%311%'
AND target_icp = true;
```

### Analytics & Reporting

**Cost breakdown by request type:**
```sql
SELECT
  request_type,
  COUNT(*) as count,
  AVG(cost_usd) as avg_cost,
  SUM(cost_usd) as total_cost
FROM enrichment_requests
GROUP BY request_type
ORDER BY total_cost DESC;
```

**Cache hit ratio:**
```sql
SELECT
  was_cached,
  COUNT(*) as count,
  ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM enrichment_requests), 2) as percentage
FROM enrichment_requests
GROUP BY was_cached;
```

**Performance statistics:**
```sql
SELECT
  AVG(response_time_ms) as avg_response_time_ms,
  MIN(response_time_ms) as min_response_time_ms,
  MAX(response_time_ms) as max_response_time_ms,
  STDDEV(response_time_ms) as stddev_response_time_ms
FROM enrichment_requests
WHERE was_cached = false;
```

**Top domains by enrichment count:**
```sql
SELECT
  domain,
  COUNT(*) as enrichment_count,
  SUM(cost_usd) as total_cost
FROM enrichment_requests
GROUP BY domain
ORDER BY enrichment_count DESC
LIMIT 20;
```

**Companies added in last 7 days:**
```sql
SELECT
  domain,
  company_name,
  company_revenue,
  target_icp,
  created_at
FROM companies
WHERE created_at > NOW() - INTERVAL '7 days'
ORDER BY created_at DESC;
```

**Quality distribution:**
```sql
SELECT
  quality->>'location.confidence' as location_confidence,
  quality->>'revenue.confidence' as revenue_confidence,
  COUNT(*) as count
FROM companies
GROUP BY
  quality->>'location.confidence',
  quality->>'revenue.confidence'
ORDER BY count DESC;
```

### Contact Queries

**Find contacts by email domain:**
```sql
SELECT
  email_address,
  first_name,
  last_name,
  job_title
FROM contacts
WHERE email_address LIKE '%@example.com'
ORDER BY created_at DESC;
```

**Find contacts by company:**
```sql
SELECT
  c.email_address,
  c.first_name,
  c.job_title,
  co.company_name
FROM contacts c
JOIN companies co ON c.company_id = co.id
WHERE co.domain = 'example.com'
ORDER BY c.created_at DESC;
```

**Find contacts with LinkedIn profiles:**
```sql
SELECT
  email_address,
  first_name,
  linked_profile_url
FROM contacts
WHERE linked_profile_url IS NOT NULL
LIMIT 50;
```

---

## Data Types Reference

### Revenue Bands

The system uses 12 predefined revenue bands:

```
"0-500K"      → $0 - $500,000
"500K-1M"     → $500,000 - $1,000,000
"1M-5M"       → $1M - $5M
"5M-10M"      → $5M - $10M
"10M-25M"     → $10M - $25M
"25M-75M"     → $25M - $75M
"75M-200M"    → $75M - $200M
"200M-500M"   → $200M - $500M
"500M-1B"     → $500M - $1B
"1B-10B"      → $1B - $10B
"10B-100B"    → $10B - $100B
"100B-1T"     → $100B - $1T
```

### Employee Bands

The system uses 9 predefined employee bands:

```
"0-1 Employees"        → 0-1
"2-10 Employees"       → 2-10
"11-50 Employees"      → 11-50
"51-200 Employees"     → 51-200
"201-500 Employees"    → 201-500
"501-1,000 Employees"  → 501-1,000
"1,001-5,000 Employees" → 1,001-5,000
"5,001-10,000 Employees" → 5,001-10,000
"10,001+ Employees"    → 10,001+
```

### NAICS Codes

NAICS codes are 6-digit industry classification codes stored as:

```json
{
  "code": "311615",
  "description": "Poultry Processing"
}
```

**Target NAICS Codes (Food & Beverage):**
- `311***` - Food Manufacturing (all subcodes)
- `424***` - Merchant Wholesalers - Nondurable Goods (grocery/food focus)
- `722***` - Food Service & Drinking Places (all subcodes)

### Quality Metrics Structure

```json
{
  "location": {
    "confidence": "high|medium|low",
    "reasoning": "Confirmed by multiple sources"
  },
  "revenue": {
    "confidence": "high|medium|low",
    "reasoning": "Extracted from SEC filing"
  },
  "size": {
    "confidence": "high|medium|low",
    "reasoning": "LinkedIn company page employee count"
  },
  "industry": {
    "confidence": "high|medium|low",
    "reasoning": "NAICS codes based on business activities"
  }
}
```

### Performance Metrics Structure

```json
{
  "pass1_ms": 1234,
  "scraping_ms": 2345,
  "pass2_ms": 3456,
  "total_ms": 7035,
  "scrape_count": 2,
  "avg_scrape_ms": 1172
}
```

### Cost Breakdown Structure

```json
{
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
    "deepResearch": {
      "model": "perplexity/sonar-pro",
      "inputTokens": 0,
      "outputTokens": 0,
      "totalTokens": 0,
      "costUsd": 0.0
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
```

---

## Maintenance

### Backing Up Data

**Export table as CSV (Supabase):**
```bash
# Via Supabase dashboard
1. Navigate to database table
2. Click "..." menu
3. Select "Export as CSV"
```

**Via SQL:**
```sql
COPY companies
TO STDOUT WITH (FORMAT csv, HEADER true);
```

### Cleaning Up Old Data

**Delete enrichment requests older than 90 days:**
```sql
DELETE FROM enrichment_requests
WHERE created_at < NOW() - INTERVAL '90 days';
```

**Find duplicate contacts (same email):**
```sql
SELECT
  email_address,
  COUNT(*) as count
FROM contacts
GROUP BY email_address
HAVING COUNT(*) > 1;
```

### Monitoring Database Health

**Check table sizes:**
```sql
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

**Check for NULL values:**
```sql
SELECT
  (SELECT COUNT(*) FROM companies WHERE company_revenue IS NULL) as null_revenues,
  (SELECT COUNT(*) FROM companies WHERE company_size IS NULL) as null_sizes,
  (SELECT COUNT(*) FROM companies WHERE linkedin_url IS NULL) as null_linkedin;
```

---

## See Also

- [API.md](API.md) - API endpoint reference
- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture and enrichment pipeline
- [DEVELOPMENT.md](DEVELOPMENT.md) - Development setup and testing

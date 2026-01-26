# Benriched - Company Enrichment API

An AI-powered company and contact enrichment API that combines web search, intelligent scraping, and AI analysis to extract structured business intelligence data.

## Overview

Benriched is a sophisticated enrichment system that automatically researches companies and extracts verified data including:
- Revenue and employee count
- Headquarters location and subsidiary status
- Business description and industry classification (NAICS codes)
- LinkedIn profile matching
- ICP (Ideal Customer Profile) matching
- Contact enrichment via ZoomInfo

The system uses a **12-stage pipeline** with intelligent caching, cost optimization, and automatic outlier detection to balance accuracy, speed, and cost.

## Key Features

✅ **Multi-stage enrichment** - 12-stage pipeline with Pass 1 (web search) and Pass 2 (content analysis)
✅ **Intelligent scraping** - Smart URL selection reduces Firecrawl costs by 50-70%
✅ **Automatic deep research** - Detects outliers and conflicting data, runs targeted queries
✅ **Parent company inheritance** - Brands inherit revenue/size data from parent companies
✅ **Cost tracking** - Transparent cost breakdown for every API call
✅ **Database caching** - Avoids re-enriching same domain
✅ **Backwards compatible** - Old endpoints remain active forever
✅ **Comprehensive quality metrics** - Confidence levels for every data point

## Quick Start

### Prerequisites

- Node.js 18+
- npm 9+
- Supabase account (database)
- API keys for external services

### Installation

```bash
# Clone repository
git clone https://github.com/yourusername/benriched.git
cd benriched

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your API keys
```

### Run Locally

```bash
npm run dev
```

API runs on `http://localhost:8787`

### Test Endpoint

```bash
curl -X POST http://localhost:8787/v1/enrich/company \
  -H "X-API-Key: amlink21" \
  -H "Content-Type: application/json" \
  -d '{"domain": "lincolnpremiumpoultry.com"}'
```

## API Endpoints

### Current (v1) Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /v1/enrich/company` | POST | Enrich company by domain |
| `POST /v1/enrich/contact` | POST | Enrich contact via ZoomInfo |
| `POST /v1/match/persona` | POST | Match job title to persona |
| `POST /v1/research/contact` | POST | Research prospect for outbound |
| `POST /v1/generate/email-sequence` | POST | Generate personalized email sequences |
| `GET /v1/health` | GET | Health check (no auth required) |

### Legacy Endpoints (Supported Indefinitely)

`POST /enrich`, `POST /enrich/contact`, `POST /persona`, `POST /research/contact`, `POST /outreach/email-sequence`

**Note:** Legacy endpoints are fully supported and will not be deprecated. They are aliases to v1 endpoints.

## Documentation

Complete documentation is organized for different audiences:

- **[API Reference](docs/API.md)** - Complete endpoint documentation, request/response formats, authentication methods, error handling
- **[System Architecture](docs/ARCHITECTURE.md)** - 12-stage enrichment pipeline, cost tracking, quality assurance mechanisms, integration details
- **[Development Guide](docs/DEVELOPMENT.md)** - Local setup, testing, deployment, contributing guidelines
- **[Database Schema](docs/DATABASE.md)** - Table definitions, indexes, common queries, data types

For system documentation used by Claude AI, see [claude.md](claude.md).

## Tech Stack

- **API Framework**: Hono (lightweight, edge-compatible)
- **Search**: Perplexity Sonar Pro (web search with real-time access)
- **Analysis**: OpenAI GPT-4o-mini (content extraction)
- **Scraping**: Firecrawl (JavaScript-rendered content)
- **Contact Enrichment**: ZoomInfo API
- **Database**: Supabase (PostgreSQL)
- **Hosting**: Vercel (serverless)

## Architecture

### Request Flow

```
Request → Cache Check → Domain Resolution → Pass 1 (Web Search)
  ↓
Deep Research (if needed) → URL Selection → Firecrawl Scraping
  ↓
Entity Mismatch Detection → LinkedIn Validation → Pass 2 (Content Analysis)
  ↓
Revenue Estimation → Parent Company Lookup → ICP Matching
  ↓
Database Storage → Cost Calculation → Response
```

### Dual-AI Architecture

1. **Pass 1 (Perplexity)**: Web search to identify company and find initial data
   - Company name and parent company relationship
   - Revenue figures from multiple sources
   - Employee count and headquarters location
   - LinkedIn profile candidates
   - URLs to scrape

2. **Pass 2 (GPT-4o-mini)**: Content analysis to extract structured data
   - Business description (primary business activity)
   - Revenue band (from 12 predefined bands)
   - Employee band (from 9 predefined bands)
   - NAICS industry codes
   - Quality metrics for each field

### Cost Optimization

- **Intelligent caching**: Cache check before any API calls
- **Smart scraping**: Conditional URL selection based on what data Pass 1 already found
- **Deep research triggers**: Automatic outlier detection (only runs when needed)
- **Typical cost**: $0.03-0.08 per company (cached hit: $0.00)

## Environment Variables

Required for local development and production:

```bash
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key_here

# AI Gateway (Vercel)
AI_GATEWAY_API_KEY=your_api_gateway_key

# Firecrawl (web scraping)
FIRECRAWL_API_KEY=your_firecrawl_key

# ZoomInfo (contact enrichment)
ZI_USERNAME=your_username
ZI_PASSWORD=your_password
ZI_AUTH_URL=https://api.zoominfo.com/api/v2/auth/token
ZI_ENRICH_URL=https://api.zoominfo.com/api/v2/contact/enrich

# Authentication
API_KEY=amlink21

# Port (optional)
PORT=8787
```

## Deployment

### Deploy to Vercel

```bash
# Manual deployment
npm run build
vercel --prod

# Or push to main branch (auto-deploys)
git push origin main
```

### Production Testing

```bash
curl -X POST https://benriched.vercel.app/v1/enrich/company \
  -H "X-API-Key: amlink21" \
  -H "Content-Type: application/json" \
  -d '{"domain": "lincolnpremiumpoultry.com"}'
```

## Response Example

```json
{
  "success": true,
  "data": {
    "company_name": "Lincoln Premium Poultry",
    "domain": "lincolnpremiumpoultry.com",
    "website": "https://lincolnpremiumpoultry.com",
    "linkedin_url": "https://www.linkedin.com/company/lincoln-premium-poultry",
    "business_description": "Premium poultry producer based in Nebraska...",
    "company_size": "1,001-5,000 Employees",
    "company_revenue": "500M-1B",
    "city": "Fremont",
    "state": "Nebraska",
    "hq_country": "US",
    "is_us_hq": true,
    "is_us_subsidiary": false,
    "naics_codes_6_digit": [
      {"code": "311615", "description": "Poultry Processing"}
    ],
    "target_icp": true,
    "quality": {
      "revenue": {"confidence": "high", "reasoning": "Confirmed by multiple sources"},
      "size": {"confidence": "high", "reasoning": "Employee count from LinkedIn"},
      "location": {"confidence": "high", "reasoning": "Confirmed by multiple sources"},
      "industry": {"confidence": "high", "reasoning": "NAICS codes based on business activities"}
    }
  },
  "cached": false,
  "cost": {
    "total": {"costUsd": 0.0456}
  },
  "performance": {
    "total_ms": 21912
  }
}
```

## Contributing

See [Development Guide](docs/DEVELOPMENT.md) for:
- Code style and testing
- Commit message conventions
- Pull request process
- Running tests and building

## Performance

**Typical Response Times:**
- Cached hit: <100ms
- Fresh enrichment: ~25-45 seconds
- With deep research: ~35-60 seconds

**Token Usage:**
- Pass 1 (Perplexity): ~1,500-2,500 input, ~800-1,200 output
- Pass 2 (GPT-4o-mini): ~3,000-5,000 input, ~500-800 output
- Deep research: ~200-400 input/output per query

## Roadmap

- [ ] OpenAPI/Swagger documentation generation
- [ ] Rate limiting on Vercel production
- [ ] Standardized error response format
- [ ] Request ID tracking for distributed tracing
- [ ] API usage analytics dashboard
- [ ] Batch enrichment endpoint
- [ ] Webhook support for async enrichments

## Support

- Check [GitHub Issues](https://github.com/yourusername/benriched/issues) for known issues
- See [Development Guide](docs/DEVELOPMENT.md#troubleshooting) for troubleshooting
- Review [Architecture](docs/ARCHITECTURE.md) for system details

## License

MIT

---

## Getting Started Checklist

- [ ] Read [Quick Start](#quick-start) section above
- [ ] Install Node.js 18+ and npm 9+
- [ ] Clone repository and install dependencies
- [ ] Create Supabase account and set up database
- [ ] Set environment variables in `.env.local`
- [ ] Run `npm run dev` to start local server
- [ ] Test with sample cURL command
- [ ] Read [API Reference](docs/API.md) for all endpoints
- [ ] Explore [System Architecture](docs/ARCHITECTURE.md) to understand pipeline
- [ ] Follow [Development Guide](docs/DEVELOPMENT.md) to contribute

---

**Current Status:** v0.1.0 (Active Development)
**Last Updated:** January 2026

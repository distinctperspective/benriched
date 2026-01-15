# Benriched - Company Enrichment API

A monorepo-based company enrichment API service that runs on the edge (Vercel Edge Functions) or in the cloud. Uses AI to research companies and extract structured business intelligence.

## Architecture

This is a **monorepo** using `pnpm` workspaces with the following structure:

```
benriched/
├── packages/
│   ├── types/          # Shared TypeScript types
│   ├── core/           # Enrichment logic (reusable)
│   └── api/            # Hono API (Vercel Edge compatible)
├── scripts/            # Legacy test scripts
└── pnpm-workspace.yaml
```

### Packages

- **`@benriched/types`**: Shared TypeScript interfaces for enrichment results, revenue data, etc.
- **`@benriched/core`**: Core enrichment logic extracted from the test script
  - Pass 1: AI identifies URLs to scrape and finds initial company data
  - Pass 2: AI analyzes scraped content and extracts structured data
  - Utilities: Parsing, revenue mapping, LinkedIn validation, etc.
- **`@benriched/api`**: Hono web framework with routes and middleware
  - `POST /enrich`: Main enrichment endpoint
  - `GET /health`: Health check
  - Built-in auth and rate limiting

## Setup

### Prerequisites

- Node.js 18+
- pnpm 8+
- API Keys:
  - OpenAI (for AI models)
  - Firecrawl (for web scraping)

### Installation

1. Clone the repo and install dependencies:
```bash
pnpm install
```

2. Create `.env.local` in the root with your API keys:
```bash
cp .env.example .env.local
```

Fill in:
- `OPENAI_API_KEY`: Your OpenAI API key
- `FIRECRAWL_API_KEY`: Your Firecrawl API key
- `API_KEY`: A secret token for API authentication

### Development

Start the API locally:
```bash
pnpm dev
```

This runs the Hono dev server on `http://localhost:8787`

### Building

Build all packages:
```bash
pnpm build
```

## API Usage

### Enrich a Company

```bash
curl -X POST http://localhost:8787/enrich \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain": "example.com"}'
```

**Request:**
```json
{
  "domain": "example.com",
  "strict": false
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "company_name": "Example Inc",
    "domain": "example.com",
    "website": "https://example.com",
    "business_description": "...",
    "company_size": "51-200 Employees",
    "company_revenue": "10M-25M",
    "city": "San Francisco",
    "state": "California",
    "hq_country": "US",
    "is_us_hq": true,
    "is_us_subsidiary": false,
    "linkedin_url": "https://www.linkedin.com/company/example/",
    "naics_codes_6_digit": [
      {"code": "511210", "description": "Software Publishers"}
    ],
    "source_urls": ["https://example.com", "..."],
    "quality": {
      "location": {"confidence": "high", "reasoning": "..."},
      "revenue": {"confidence": "high", "reasoning": "..."},
      "size": {"confidence": "high", "reasoning": "..."},
      "industry": {"confidence": "high", "reasoning": "..."}
    },
    "target_icp": false,
    "target_icp_matches": []
  }
}
```

### Health Check

```bash
curl http://localhost:8787/health
```

## Deployment

### Deploy to Vercel Edge

```bash
cd packages/api
pnpm deploy
```

The API will be available at your Vercel deployment URL.

### Environment Variables

Set these in your Vercel project settings:
- `OPENAI_API_KEY`
- `FIRECRAWL_API_KEY`
- `API_KEY`

## Future Enhancements

- [ ] Database integration (Supabase) for storing enrichment results
- [ ] Admin dashboard for managing enrichments
- [ ] Logging and analytics
- [ ] Webhook support for async enrichments
- [ ] Batch enrichment endpoint
- [ ] Caching layer

## Project Structure

```
packages/api/
├── src/
│   ├── routes/
│   │   ├── health.ts
│   │   └── enrich.ts
│   ├── middleware/
│   │   ├── auth.ts
│   │   └── rateLimit.ts
│   └── index.ts
├── wrangler.toml
└── package.json

packages/core/
├── src/
│   ├── enrichment/
│   │   ├── pass1.ts
│   │   └── pass2.ts
│   ├── utils/
│   │   ├── parsing.ts
│   │   └── revenue.ts
│   ├── scraper.ts
│   ├── validators.ts
│   └── index.ts
└── package.json

packages/types/
├── src/
│   └── index.ts
└── package.json
```

## License

MIT

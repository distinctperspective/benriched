# Development Guide

This guide covers setting up the Benriched API for local development, testing endpoints, and deploying to production.

## Table of Contents

1. [Development Setup](#development-setup)
2. [Local Development](#local-development)
3. [Code Structure](#code-structure)
4. [Testing Endpoints](#testing-endpoints)
5. [Deployment](#deployment)
6. [Contributing Guidelines](#contributing-guidelines)

---

## Development Setup

### Prerequisites

- **Node.js** (v18 or higher)
- **npm** (v9 or higher)
- **Supabase account** (for database)
- **API Keys** for external services (see below)

### Environment Variables

Create a `.env.local` file in the project root with the following variables:

```bash
# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key_here

# AI Gateway (Vercel AI Gateway)
AI_GATEWAY_API_KEY=your_ai_gateway_key_here

# Firecrawl API
FIRECRAWL_API_KEY=your_firecrawl_api_key_here

# ZoomInfo Configuration (optional, for contact enrichment)
ZI_USERNAME=your_zoominfo_username
ZI_PASSWORD=your_zoominfo_password
ZI_AUTH_URL=https://api.zoominfo.com/api/v2/auth/token
ZI_ENRICH_URL=https://api.zoominfo.com/api/v2/contact/enrich

# API Key for authentication
API_KEY=amlink21

# Port for local development
PORT=8787
```

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/benriched.git
   cd benriched
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   ```bash
   cp .env.example .env.local
   # Edit .env.local with your actual API keys
   ```

4. **Set up database** (Supabase):
   - Log in to your Supabase project
   - Run migrations to create tables:
     ```sql
     -- companies table
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

     -- enrichment_requests table
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

     -- contacts table
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
     ```

---

## Local Development

### Running the Server

**Start the development server:**
```bash
npm run dev
```

The API will be available at `http://localhost:8787`

**API Health Check:**
```bash
curl http://localhost:8787/v1/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2026-01-25T12:34:56.789Z",
  "version": "0.1.0"
}
```

### Authentication Methods

The API supports multiple authentication methods. Use any one of:

**1. Authorization Header (Bearer Token):**
```bash
curl -H "Authorization: Bearer amlink21" http://localhost:8787/v1/enrich/company
```

**2. X-API-Key Header:**
```bash
curl -H "X-API-Key: amlink21" http://localhost:8787/v1/enrich/company
```

**3. Query Parameter:**
```bash
curl http://localhost:8787/v1/enrich/company?api_key=amlink21
```

**4. Request Body:**
```bash
curl -X POST http://localhost:8787/v1/enrich/company \
  -H "Content-Type: application/json" \
  -d '{"domain": "example.com", "api_key": "amlink21"}'
```

### Common Development Tasks

**Test a specific endpoint:**
```bash
curl -X POST http://localhost:8787/v1/enrich/company \
  -H "X-API-Key: amlink21" \
  -H "Content-Type: application/json" \
  -d '{"domain": "lincolnpremiumpoultry.com"}'
```

**Force cache refresh:**
```bash
curl -X POST http://localhost:8787/v1/enrich/company \
  -H "X-API-Key: amlink21" \
  -H "Content-Type: application/json" \
  -d '{"domain": "lincolnpremiumpoultry.com", "force_refresh": true}'
```

**Enable deep research:**
```bash
curl -X POST http://localhost:8787/v1/enrich/company \
  -H "X-API-Key: amlink21" \
  -H "Content-Type: application/json" \
  -d '{"domain": "lincolnpremiumpoultry.com", "deep_research": true}'
```

**Test contact enrichment:**
```bash
curl -X POST http://localhost:8787/v1/enrich/contact \
  -H "X-API-Key: amlink21" \
  -H "Content-Type: application/json" \
  -d '{"email": "john@example.com", "first_name": "John"}'
```

---

## Code Structure

### Directory Organization

```
benriched/
├── api/
│   └── index.ts                    # Vercel serverless handler
├── src/
│   ├── index.ts                    # Main Hono app
│   ├── middleware/
│   │   ├── auth.ts                 # API key authentication
│   │   └── rateLimit.ts            # Rate limiting
│   ├── routes/
│   │   ├── v1/                     # v1 API endpoints
│   │   │   ├── enrich/
│   │   │   │   ├── company.ts      # Company enrichment
│   │   │   │   ├── contact.ts      # Contact enrichment
│   │   │   │   └── index.ts        # Enrich router
│   │   │   ├── research/
│   │   │   │   ├── contact.ts      # Contact research
│   │   │   │   └── index.ts        # Research router
│   │   │   ├── match/
│   │   │   │   ├── persona.ts      # Persona matching
│   │   │   │   └── index.ts        # Match router
│   │   │   ├── generate/
│   │   │   │   ├── email-sequence.ts # Email generation
│   │   │   │   └── index.ts        # Generate router
│   │   │   ├── health.ts           # Health check
│   │   │   └── index.ts            # v1 master router
│   │   └── legacy/
│   │       └── aliases.ts          # Legacy endpoint aliases
│   ├── enrichment/
│   │   ├── enrich.ts               # Core enrichment logic
│   │   ├── components/
│   │   │   ├── pass1.ts            # Web search (Perplexity)
│   │   │   ├── pass2.ts            # Content analysis (GPT-4o-mini)
│   │   │   ├── deepResearch.ts     # Deep research queries
│   │   │   └── ...                 # Other components
│   │   └── ...
│   ├── lib/
│   │   ├── supabase.ts             # Supabase client
│   │   ├── contact-enrich.ts       # ZoomInfo integration
│   │   └── ...
│   └── utils/
│       └── ...
├── docs/
│   ├── API.md                      # API reference
│   ├── ARCHITECTURE.md             # System architecture
│   ├── DEVELOPMENT.md              # This file
│   ├── DATABASE.md                 # Database schema
│   └── integrations/
│       └── VELLIUM.md              # Vellium integration
├── .env.example
├── package.json
├── tsconfig.json
├── vercel.json
└── README.md
```

### Route Structure

**v1 Routes (Versioned API):**
- `POST /v1/enrich/company` - Company enrichment by domain
- `POST /v1/enrich/contact` - Contact enrichment via ZoomInfo
- `POST /v1/research/contact` - Prospect research
- `POST /v1/match/persona` - Job title persona matching
- `POST /v1/generate/email-sequence` - Email sequence generation
- `GET /v1/health` - Health check

**Legacy Routes (Backwards Compatibility):**
- `POST /enrich` → `POST /v1/enrich/company`
- `POST /enrich/contact` → `POST /v1/enrich/contact`
- `POST /persona` → `POST /v1/match/persona`
- `POST /research/contact` → `POST /v1/research/contact`
- `POST /outreach/email-sequence` → `POST /v1/generate/email-sequence`

### Middleware

**Authentication (src/middleware/auth.ts):**
- Checks for API key in query params, headers, or body
- Returns 401 if missing or invalid
- Sets `apiKey` in context for downstream handlers

**Rate Limiting (src/middleware/rateLimit.ts):**
- Applied to all enrichment endpoints
- Configurable limits per route
- Returns 429 if limit exceeded

---

## Testing Endpoints

### Testing All v1 Endpoints

**1. Company Enrichment:**
```bash
curl -X POST http://localhost:8787/v1/enrich/company \
  -H "X-API-Key: amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "lincolnpremiumpoultry.com",
    "force_refresh": false
  }'
```

**2. Contact Enrichment:**
```bash
curl -X POST http://localhost:8787/v1/enrich/contact \
  -H "X-API-Key: amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "nellie@oishii.com",
    "first_name": "Nellie"
  }'
```

**3. Contact Research:**
```bash
curl -X POST http://localhost:8787/v1/research/contact \
  -H "X-API-Key: amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "prospect_name": "Jessica Packard",
    "company_name": "Timeero"
  }'
```

**4. Persona Matching:**
```bash
curl -X POST http://localhost:8787/v1/match/persona \
  -H "X-API-Key: amlink21" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Food Safety Manager"
  }'
```

### Testing Authentication Methods

**Bearer Token:**
```bash
curl -X POST http://localhost:8787/v1/enrich/company \
  -H "Authorization: Bearer amlink21" \
  -H "Content-Type: application/json" \
  -d '{"domain": "example.com"}'
```

**X-API-Key Header:**
```bash
curl -X POST http://localhost:8787/v1/enrich/company \
  -H "X-API-Key: amlink21" \
  -H "Content-Type: application/json" \
  -d '{"domain": "example.com"}'
```

**Query Parameter:**
```bash
curl -X POST "http://localhost:8787/v1/enrich/company?api_key=amlink21" \
  -H "Content-Type: application/json" \
  -d '{"domain": "example.com"}'
```

### Testing Legacy Endpoints

**Legacy company enrichment (backwards compatible):**
```bash
curl -X POST http://localhost:8787/enrich \
  -H "X-API-Key: amlink21" \
  -H "Content-Type: application/json" \
  -d '{"domain": "lincolnpremiumpoultry.com"}'
```

**Verify it returns the same as v1:**
```bash
# v1
curl -X POST http://localhost:8787/v1/enrich/company \
  -H "X-API-Key: amlink21" \
  -d '{"domain": "example.com"}'

# Legacy (should be identical)
curl -X POST http://localhost:8787/enrich \
  -H "X-API-Key: amlink21" \
  -d '{"domain": "example.com"}'
```

### Database Verification

**Check cached companies:**
```bash
# Connect to Supabase SQL editor
SELECT domain, company_name, created_at FROM companies LIMIT 10;
```

**Check enrichment requests:**
```bash
SELECT domain, request_type, was_cached, cost_usd FROM enrichment_requests LIMIT 10;
```

**Check contacts:**
```bash
SELECT email_address, first_name, job_title FROM contacts LIMIT 10;
```

---

## Deployment

### Vercel Deployment

**Automatic deployment:**
The project automatically deploys to Vercel when you push to the main branch.

**Manual deployment:**
```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
vercel

# Deploy to production
vercel --prod
```

### Environment Variables in Vercel

1. Go to Vercel project settings
2. Navigate to Environment Variables
3. Add all variables from your `.env.local`:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `AI_GATEWAY_API_KEY`
   - `FIRECRAWL_API_KEY`
   - `ZI_USERNAME`
   - `ZI_PASSWORD`
   - `ZI_AUTH_URL`
   - `ZI_ENRICH_URL`
   - `API_KEY`

### Testing Production Deployment

**Test production endpoint:**
```bash
curl -X POST https://benriched.vercel.app/v1/enrich/company \
  -H "X-API-Key: amlink21" \
  -H "Content-Type: application/json" \
  -d '{"domain": "lincolnpremiumpoultry.com"}'
```

**Verify health check:**
```bash
curl https://benriched.vercel.app/v1/health
```

**Check legacy endpoint in production:**
```bash
curl -X POST https://benriched.vercel.app/enrich \
  -H "X-API-Key: amlink21" \
  -H "Content-Type: application/json" \
  -d '{"domain": "lincolnpremiumpoultry.com"}'
```

### Monitoring Production

**Vercel Logs:**
- Navigate to Vercel project dashboard
- Click "Deployments" tab
- View logs for recent deployments
- Check "Functions" tab for serverless logs

**Supabase Logs:**
- Go to Supabase dashboard
- Check "Logs" section for database errors
- Review "Analytics" for query performance

---

## Contributing Guidelines

### Code Style

- Use TypeScript for all new code
- Follow existing code patterns
- Format code with Prettier:
  ```bash
  npm run format
  ```

### Before Committing

1. **Run tests:**
   ```bash
   npm test
   ```

2. **Format code:**
   ```bash
   npm run format
   ```

3. **Check types:**
   ```bash
   npm run type-check
   ```

### Commit Message Convention

Follow conventional commits:
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `style:` Code style (formatting, missing semicolons, etc.)
- `refactor:` Code refactoring
- `test:` Adding or updating tests
- `chore:` Build, dependencies, tooling

Examples:
```bash
git commit -m "feat: add async enrichment mode"
git commit -m "fix: handle null revenue values in parent company inheritance"
git commit -m "docs: update architecture guide with new stage 3 details"
```

### Pull Request Process

1. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make changes and commit:
   ```bash
   git add .
   git commit -m "feat: describe your changes"
   ```

3. Push to GitHub:
   ```bash
   git push origin feature/your-feature-name
   ```

4. Open a pull request on GitHub
   - Link any related issues
   - Describe what you changed and why
   - Provide testing steps

5. Address review feedback
6. Merge once approved

---

## Troubleshooting

### Common Issues

**1. "Cannot find module" errors:**
```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

**2. Supabase connection errors:**
- Verify `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `.env.local`
- Check Supabase project is active
- Verify tables exist in database

**3. API key authentication failing:**
- Ensure `API_KEY=amlink21` is set in `.env.local`
- Verify you're using correct authentication method
- Check Authorization header format: `Bearer amlink21` (with space)

**4. Deep research not triggering:**
- Verify `AI_GATEWAY_API_KEY` is set
- Check Perplexity API is accessible
- Review logs for specific error messages

**5. Firecrawl errors:**
- Verify `FIRECRAWL_API_KEY` is correct
- Check target URL is accessible
- Review Firecrawl dashboard for credit usage

### Getting Help

- Check existing GitHub issues
- Review logs in Vercel or Supabase dashboard
- Add `console.log` or debugging statements
- Run with debug flag:
  ```bash
  DEBUG=* npm run dev
  ```

---

## Next Steps

- Read [API.md](API.md) for endpoint reference
- Read [ARCHITECTURE.md](ARCHITECTURE.md) for system design
- Read [DATABASE.md](DATABASE.md) for schema details
- Explore the codebase in `src/routes/` to understand route handlers

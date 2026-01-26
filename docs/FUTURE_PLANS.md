# Future Plans & Enhancements

This document outlines planned features and improvements for future implementation.

---

## Prompt Template System

**Status:** Planned
**Priority:** Medium
**Estimated Effort:** 3-4 weeks

### Overview

Create a database-backed prompt template system to replace hardcoded AI prompts with editable, versioned templates stored in Supabase. This enables runtime prompt editing, A/B testing, and centralized prompt management without code deployments.

### Current State

- 10 different AI prompts hardcoded across 8 TypeScript files
- Prompts embedded directly in code (87-177 lines each)
- No version control for prompt changes
- Requires code deployment to update prompts
- No ability to A/B test different prompt variations

### Goals

- Store all prompts in Supabase database
- Support variable interpolation ({{domain}}, {{companyName}}, etc.)
- Enable versioning with rollback capability
- Frontend admin UI for prompt management (in benriched-frontend repo)
- Maintain backwards compatibility during migration

---

## Prompt Inventory

### Identified Prompts

| Prompt Type | File Location | Model | Variables | Lines |
|-------------|---------------|-------|-----------|-------|
| Pass 1 Web Search | src/enrichment/components/pass1.ts:87-177 | Perplexity Sonar Pro | domain, previousCompanyName | 91 |
| Pass 2 Content Analysis | src/enrichment/components/prompts.ts:24-126 | GPT-4o-mini | companyName, domain, scrapedContent, pass1Data | 103 |
| Deep Research - Revenue | src/enrichment/deepResearch.ts:202-222 | Perplexity Sonar Pro | domain, companyName | 21 |
| Deep Research - Employee | src/enrichment/deepResearch.ts:250-270 | Perplexity Sonar Pro | domain, companyName | 21 |
| Deep Research - Location | src/enrichment/deepResearch.ts:302-322 | Perplexity Sonar Pro | domain, companyName | 21 |
| NAICS Code Selection | src/enrichment/components/naics.ts:51-88 | GPT-4o-mini | domain, companyName, businessDescription, APPROVED_NAICS_LIST | 38 |
| Persona Matching | src/lib/persona.ts:6-50 | GPT-4o-mini | JOB_TITLE, PERSONAS_LIST | 45 |
| Tier Classification | src/lib/tier.ts:4-55 | GPT-4o-mini | JOB_TITLE | 52 |
| Contact Research | src/lib/research.ts:46-155 | Perplexity Sonar Pro | PROSPECT_NAME, COMPANY_NAME, LINKEDIN_URL | 110 |
| Email Sequence | src/lib/outreach.ts:157-227 | GPT-4-turbo | prospectName, title, company_name, industry, etc. | 71 |

**Total:** 10 prompts across 8 files

---

## Database Schema Design

### Table: prompt_templates

```sql
CREATE TABLE prompt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identification
  name TEXT NOT NULL UNIQUE,              -- Unique identifier (e.g., "pass1_web_search")
  display_name TEXT NOT NULL,             -- Human-readable name
  description TEXT,                       -- Purpose and usage notes
  category TEXT NOT NULL,                 -- "enrichment", "research", "persona", "outreach"

  -- AI Configuration
  model TEXT NOT NULL,                    -- "perplexity/sonar-pro", "openai/gpt-4o-mini", etc.
  temperature DECIMAL(3,2) DEFAULT 0.0,   -- Temperature setting
  max_tokens INTEGER,                     -- Max output tokens

  -- Prompt Content
  template_text TEXT NOT NULL,            -- Prompt with {{variable}} placeholders
  system_prompt TEXT,                     -- Optional system message
  output_format TEXT,                     -- "json", "text", "markdown"
  output_schema JSONB,                    -- JSON schema for structured outputs

  -- Variables
  required_variables JSONB NOT NULL,      -- ["domain", "companyName"]
  optional_variables JSONB DEFAULT '[]',  -- ["previousCompanyName"]
  variable_descriptions JSONB,            -- {domain: "Company domain", ...}

  -- Versioning
  version INTEGER NOT NULL DEFAULT 1,     -- Version number
  is_active BOOLEAN DEFAULT true,         -- Whether this version is active
  parent_version_id UUID,                 -- References previous version

  -- Metadata
  created_by TEXT,                        -- User who created this version
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  -- Performance Tracking
  usage_count INTEGER DEFAULT 0,          -- Times this prompt was used
  avg_cost_usd DECIMAL(10,6),             -- Average cost per execution
  avg_tokens_input INTEGER,               -- Average input tokens
  avg_tokens_output INTEGER,              -- Average output tokens

  CONSTRAINT fk_parent_version FOREIGN KEY (parent_version_id)
    REFERENCES prompt_templates(id) ON DELETE SET NULL
);

-- Indexes
CREATE INDEX idx_prompt_templates_name ON prompt_templates(name);
CREATE INDEX idx_prompt_templates_active ON prompt_templates(is_active) WHERE is_active = true;
CREATE INDEX idx_prompt_templates_category ON prompt_templates(category);
CREATE INDEX idx_prompt_templates_version ON prompt_templates(name, version);

-- Unique constraint: only one active version per prompt name
CREATE UNIQUE INDEX idx_prompt_templates_active_name
  ON prompt_templates(name)
  WHERE is_active = true;
```

### Table: prompt_executions (Optional - for analytics)

```sql
CREATE TABLE prompt_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_template_id UUID NOT NULL REFERENCES prompt_templates(id),

  -- Execution Context
  variables JSONB NOT NULL,               -- Input variables used
  rendered_prompt TEXT NOT NULL,          -- Final prompt after interpolation

  -- Results
  model_response TEXT,                    -- AI response
  tokens_input INTEGER,                   -- Actual input tokens
  tokens_output INTEGER,                  -- Actual output tokens
  cost_usd DECIMAL(10,6),                 -- Actual cost
  duration_ms INTEGER,                    -- Execution time

  -- Metadata
  executed_at TIMESTAMP DEFAULT NOW(),
  request_id TEXT,                        -- Link to enrichment_requests
  success BOOLEAN DEFAULT true,
  error_message TEXT,

  CONSTRAINT fk_prompt_template FOREIGN KEY (prompt_template_id)
    REFERENCES prompt_templates(id) ON DELETE CASCADE
);

CREATE INDEX idx_prompt_executions_template ON prompt_executions(prompt_template_id);
CREATE INDEX idx_prompt_executions_executed_at ON prompt_executions(executed_at);
CREATE INDEX idx_prompt_executions_request_id ON prompt_executions(request_id);
```

---

## Variable Interpolation System

### Syntax: Handlebars-style `{{variable}}`

**Advantages:**
- Industry standard (used by Mustache, Handlebars, Vellium)
- Easy to read and write
- Supports nested variables: `{{pass1Data.companyName}}`
- Can add helpers later: `{{uppercase domain}}`

**Example Template:**

```text
You are analyzing a company website. Extract the following information about {{companyName}} (domain: {{domain}}):

1. Business description (2-4 sentences)
2. Revenue band: {{revenueBands}}
3. Employee band: {{employeeBands}}
4. NAICS codes (up to 3)

Scraped content:
{{scrapedContent}}

Previous analysis:
{{pass1Data}}
```

---

## Implementation Strategy

### Phase 1: Database Schema & Utility Functions

1. **Create migration**: `src/migrations/add_prompt_templates.sql`
   - Create `prompt_templates` table
   - Create `prompt_executions` table (optional)
   - Create RPC function: `increment_prompt_usage`

2. **Create utility library**: `src/lib/promptTemplates.ts`
   - `interpolate()` - variable substitution
   - `validateVariables()` - check required vars
   - `loadPromptTemplate()` - fetch from DB
   - `renderPrompt()` - load + validate + interpolate
   - `logPromptExecution()` - analytics tracking

3. **Seed initial prompts**: `src/scripts/seedPrompts.ts`
   - Extract all 10 hardcoded prompts
   - Insert into database with version 1
   - Mark all as active

### Phase 2: Refactor Code to Use Templates

**Strategy:** Hybrid approach with fallback to hardcoded prompts

**Files to Refactor (in order):**

1. src/enrichment/components/pass1.ts - Pass 1 Web Search
2. src/enrichment/components/prompts.ts - Pass 2 Content Analysis
3. src/enrichment/deepResearch.ts - 3 Deep Research prompts
4. src/enrichment/components/naics.ts - NAICS Selection
5. src/lib/persona.ts - Persona Matching
6. src/lib/tier.ts - Tier Classification
7. src/lib/research.ts - Contact Research
8. src/lib/outreach.ts - Email Sequence

### Phase 3: Frontend Integration

**Location:** benriched-frontend repository

**Implementation:**
- Create `/src/app/(dashboard)/prompts/page.tsx` for prompt management UI
- Direct Supabase client integration (no backend API needed)
- Features:
  - List all prompts in table view
  - Edit prompt text in Monaco editor
  - Preview rendered output with sample variables
  - View version history timeline
  - Rollback to previous version (one click)
  - Analytics: cost per prompt, success rate, token usage

**Backend Role (benriched repo):**
- Load prompts from database
- Render them with variables
- Track execution analytics
- **NO admin API endpoints** (frontend uses Supabase client directly)

---

## Benefits

1. **Runtime Editing**: Update prompts instantly without code deployments
2. **Version Control**: Track all changes with rollback capability
3. **A/B Testing**: Run multiple prompt versions simultaneously
4. **Centralized Management**: Single source of truth for all AI prompts
5. **Cost Optimization**: Track per-prompt costs and optimize underperformers
6. **Collaboration**: Non-engineers can edit prompts via frontend UI
7. **Audit Trail**: Full history of who changed what and when
8. **Model Flexibility**: Change AI models per prompt without touching code

---

## Success Criteria

- All 10 prompts stored in database with version 1
- Variable interpolation works with {{variable}} syntax
- Prompts can be edited via frontend without code deployment
- Version history tracked with rollback capability
- Backwards compatible - all existing enrichment endpoints work identically
- Performance unchanged - database lookups add <10ms overhead
- Analytics tracking - prompt_executions table logs usage
- Zero regressions - all tests pass, responses identical

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Database down → prompts fail | Fallback to hardcoded prompts in code (keep during migration) |
| Bad prompt breaks enrichment | Version rollback via frontend UI, keep previous versions |
| Performance overhead | Cache loaded templates in memory (TTL: 5 minutes) |
| Missing variables crash system | Validate variables before rendering, throw clear error |
| Multiple active versions | Database unique constraint prevents this |
| Accidental deletion | Soft delete or archive instead of hard delete |

---

## Future Enhancements

**Not in scope for initial implementation, but valuable later:**

1. **Prompt A/B Testing**: Run 2 versions simultaneously, compare results
2. **Template Inheritance**: Base templates with overrides per use case
3. **Conditional Logic**: `{{#if}}` blocks in templates (full Handlebars)
4. **Prompt Optimization**: ML-based suggestions for better prompts
5. **Cost Alerts**: Notify when prompt cost exceeds threshold
6. **Prompt Marketplace**: Share high-performing prompts across team
7. **Git Integration**: Auto-commit prompt changes to repo
8. **Approval Workflow**: Require review before activating new versions
9. **Localization**: Multi-language prompt templates

---

## Related Documentation

- [System Architecture](ARCHITECTURE.md) - 12-stage enrichment pipeline
- [Database Schema](DATABASE.md) - Existing database tables
- [Development Guide](DEVELOPMENT.md) - Local setup and testing

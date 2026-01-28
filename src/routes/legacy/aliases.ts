import { Hono } from 'hono';
import { handleCompanyEnrichment } from '../v1/enrich/company.js';
import { handleContactEnrichment } from '../v1/enrich/contact.js';
import { handlePersonaMatch } from '../v1/match/persona.js';
import { handleContactResearch } from '../v1/research/contact.js';
import { handleEmailSequenceGeneration } from '../v1/generate/email-sequence.js';
import { handleContactSearch } from '../v1/search/contacts.js';

const legacy = new Hono();

// POST /enrich → POST /v1/enrich/company
legacy.post('/enrich', async (c) => {
  return handleCompanyEnrichment(c);
});

// POST /enrich/contact → POST /v1/enrich/contact
legacy.post('/enrich/contact', async (c) => {
  return handleContactEnrichment(c);
});

// POST /persona → POST /v1/match/persona
legacy.post('/persona', async (c) => {
  return handlePersonaMatch(c);
});

// POST /research/contact → POST /v1/research/contact (no change)
legacy.post('/research/contact', async (c) => {
  return handleContactResearch(c);
});

// POST /outreach/email-sequence → POST /v1/generate/email-sequence
legacy.post('/outreach/email-sequence', async (c) => {
  return handleEmailSequenceGeneration(c);
});

// POST /search/contacts → POST /v1/search/contacts
legacy.post('/search/contacts', async (c) => {
  return handleContactSearch(c);
});

// GET /health → GET /v1/health
legacy.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0'
  });
});

export default legacy;

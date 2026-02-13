import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import v1Routes from './routes/v1/index.js';
import legacyRoutes from './routes/legacy/aliases.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';

const app = new Hono();

// Skip problematic Hono middleware on Vercel - use minimal setup for compatibility
const isVercel = process.env.VERCEL === '1';

if (!isVercel) {
  app.use(logger());
  app.use(cors());
}

// Root endpoint
app.get('/', (c) => {
  return c.json({
    name: 'Benriched API',
    version: '0.1.0',
    description: 'Company enrichment API service',
    endpoints: {
      v1: {
        health: 'GET /v1/health',
        enrich_company: 'POST /v1/enrich/company',
        enrich_contact: 'POST /v1/enrich/contact',
        match_persona: 'POST /v1/match/persona',
        research_contact: 'POST /v1/research/contact',
        generate_email_sequence: 'POST /v1/generate/email-sequence',
        search_contacts: 'POST /v1/search/contacts',
        search_companies: 'POST /v1/search/companies'
      },
      legacy: {
        health: 'GET /health (use /v1/health)',
        enrich: 'POST /enrich (use /v1/enrich/company)',
        persona: 'POST /persona (use /v1/match/persona)',
        research_contact: 'POST /research/contact (use /v1/research/contact)',
        outreach_email_sequence: 'POST /outreach/email-sequence (use /v1/generate/email-sequence)',
        search_contacts: 'POST /search/contacts (use /v1/search/contacts)',
        search_companies: 'POST /search/companies (use /v1/search/companies)'
      }
    },
    migration: 'Legacy endpoints are supported indefinitely. Consider migrating to v1 endpoints.'
  });
});

// Mount v1 routes with auth middleware (except health and clay/callback)
app.use('/v1/enrich/*', rateLimitMiddleware);
app.use('/v1/enrich/*', authMiddleware);
app.use('/v1/research/*', rateLimitMiddleware);
app.use('/v1/research/*', authMiddleware);
app.use('/v1/match/*', rateLimitMiddleware);
app.use('/v1/match/*', authMiddleware);
app.use('/v1/generate/*', rateLimitMiddleware);
app.use('/v1/generate/*', authMiddleware);
app.use('/v1/search/*', rateLimitMiddleware);
app.use('/v1/search/*', authMiddleware);
app.use('/v1/clay/enrich/*', rateLimitMiddleware);
app.use('/v1/clay/enrich/*', authMiddleware);
app.use('/v1/clay/webhooks/*', rateLimitMiddleware);
app.use('/v1/clay/webhooks/*', authMiddleware);
// NOTE: /v1/clay/callback has NO auth — Clay must call it directly

// Mount legacy routes with auth middleware (except health)
app.use('/enrich*', rateLimitMiddleware);
app.use('/enrich*', authMiddleware);
app.use('/persona*', rateLimitMiddleware);
app.use('/persona*', authMiddleware);
app.use('/research*', rateLimitMiddleware);
app.use('/research*', authMiddleware);
app.use('/outreach*', rateLimitMiddleware);
app.use('/outreach*', authMiddleware);
app.use('/search*', rateLimitMiddleware);
app.use('/search*', authMiddleware);

app.route('/v1', v1Routes);
app.route('/', legacyRoutes);

export default app;

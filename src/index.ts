import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import healthRoutes from './routes/health.js';
import enrichRoutes from './routes/enrich.js';
import personaRoutes from './routes/persona.js';
import researchRoutes from './routes/research.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';

const app = new Hono();

app.use(logger());
app.use(cors());

app.get('/', (c) => {
  return c.json({
    name: 'Benriched API',
    version: '0.1.0',
    description: 'Company enrichment API service',
    endpoints: {
      health: 'GET /health',
      enrich: 'POST /enrich',
      persona: 'POST /persona',
      research_contact: 'POST /research/contact'
    }
  });
});

app.route('/health', healthRoutes);

app.use('/enrich', rateLimitMiddleware);
app.use('/enrich', authMiddleware);
app.route('/enrich', enrichRoutes);

app.use('/persona', rateLimitMiddleware);
app.use('/persona', authMiddleware);
app.route('/persona', personaRoutes);

app.use('/research', rateLimitMiddleware);
app.use('/research', authMiddleware);
app.route('/research', researchRoutes);

export default app;

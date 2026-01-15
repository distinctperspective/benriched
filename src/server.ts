import { config } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load env BEFORE importing app (gateway reads env on import)
config({ path: resolve(__dirname, '..', '.env.local') });

// Now import app after env is loaded
const { serve } = await import('@hono/node-server');
const { default: app } = await import('./index.js');

const port = parseInt(process.env.PORT || '8787');

serve({
  fetch: app.fetch,
  port,
}, (info) => {
  console.log(`🚀 API running on http://localhost:${info.port}`);
});

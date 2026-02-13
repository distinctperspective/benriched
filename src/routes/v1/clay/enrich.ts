import { Hono } from 'hono';
import { Context } from 'hono';
import { enrich } from '../../../lib/clay.js';
import { AppEnv } from '../../../types.js';

export async function handleClayEnrich(c: Context<AppEnv>) {
  try {
    const body = await c.req.json<{
      webhook: string;
      data: Record<string, unknown>;
      lookupKey: string;
      forceRefresh?: boolean;
    }>();

    const { webhook, data, lookupKey, forceRefresh } = body;

    if (!webhook) {
      return c.json({ error: 'webhook is required' }, 400);
    }
    if (!data || typeof data !== 'object') {
      return c.json({ error: 'data object is required' }, 400);
    }
    if (!lookupKey) {
      return c.json({ error: 'lookupKey is required' }, 400);
    }

    const result = await enrich(webhook, data, lookupKey, {
      forceRefresh: forceRefresh || false,
    });

    return c.json({ success: true, ...result });
  } catch (error) {
    console.error('[Clay Enrich] Error:', error);

    const message = error instanceof Error ? error.message : 'Failed to enrich';
    const status = message.includes('not found')
      ? 404
      : message.includes('disabled')
        ? 422
        : message.includes('timed out')
          ? 504
          : 500;

    return c.json({ success: false, error: message }, status);
  }
}

const app = new Hono();
app.post('/', handleClayEnrich);

export default app;

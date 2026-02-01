import { Hono } from 'hono';
import { Context } from 'hono';
import { matchPersona } from '../../../lib/persona.js';
import { supabase } from '../../../lib/supabase.js';
import { AppEnv } from '../../../types.js';

export async function handlePersonaMatch(c: Context<AppEnv>) {
  try {
    const body = await c.req.json<{ title: string; api_key?: string }>();
    const { title, api_key } = body;

    if (!title) {
      return c.json({ error: 'Missing required field: title' }, 400);
    }

    // Get API key from request or environment
    const apiKey = api_key || process.env.API_KEY;

    if (!apiKey) {
      return c.json({ error: 'API key required' }, 401);
    }

    // Call the shared persona matching function
    const result = await matchPersona(title, supabase);

    return c.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Persona matching error:', error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      },
      500
    );
  }
}

const app = new Hono();
app.post('/', handlePersonaMatch);

export default app;

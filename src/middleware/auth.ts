import { Context, Next } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { AppEnv } from '../types.js';

// Valid API keys (same as Vercel deployment)
const VALID_API_KEYS = ['amlink21'];

export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  try {
    // Check query parameter first (e.g., ?api_key=amlink21)
    let queryApiKey: string | undefined;
    try {
      queryApiKey = c.req.query('api_key');
    } catch (e) {
      // Can't parse query on Vercel, skip
    }

    // Then check Authorization header
    let headerToken: string | null = null;
    try {
      const authHeader = c.req.header('Authorization');
      if (authHeader) {
        const [scheme, token] = authHeader.split(' ');
        if (scheme === 'Bearer' && token) {
          headerToken = token;
        }
      }
    } catch (e) {
      // Can't read header on Vercel, skip
    }

    const providedKey = queryApiKey || headerToken;

    if (!providedKey) {
      return c.json({ error: 'Missing API key. Use ?api_key=<key> or Authorization: Bearer <key>' }, 401);
    }

    // Check against valid keys list or env var (static API key auth)
    const envKey = process.env.API_KEY || (c.env as any)?.API_KEY;
    const isStaticKey = VALID_API_KEYS.includes(providedKey) || providedKey === envKey;

    if (isStaticKey) {
      c.set('apiKey', providedKey);
      c.set('userId', null);
      await next();
      return;
    }

    // Not a static key — try as Supabase JWT
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return c.json({ error: 'Invalid API key' }, 401);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { data: { user }, error } = await supabase.auth.getUser(providedKey);

    if (error || !user) {
      return c.json({ error: 'Invalid API key' }, 401);
    }

    c.set('apiKey', providedKey);
    c.set('userId', user.id);
    await next();
  } catch (e) {
    // On critical errors, still allow request through (don't block)
    console.log('Auth middleware error, allowing request:', e);
    c.set('userId', null);
    await next();
  }
}

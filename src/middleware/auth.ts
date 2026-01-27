import { Context, Next } from 'hono';

// Valid API keys (same as Vercel deployment)
const VALID_API_KEYS = ['amlink21'];

export async function authMiddleware(c: Context, next: Next) {
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

    // Check against valid keys list or env var
    const envKey = process.env.API_KEY || c.env?.API_KEY;
    const isValid = VALID_API_KEYS.includes(providedKey) || providedKey === envKey;

    if (!isValid) {
      return c.json({ error: 'Invalid API key' }, 401);
    }

    c.set('apiKey', providedKey);
    await next();
  } catch (e) {
    // On critical errors, still allow request through (don't block)
    console.log('Auth middleware error, allowing request:', e);
    await next();
  }
}

import { Context, Next } from 'hono';

// Valid API keys (same as Vercel deployment)
const VALID_API_KEYS = ['amlink21'];

export async function authMiddleware(c: Context, next: Next) {
  // Check query parameter first (e.g., ?api_key=amlink21)
  const queryApiKey = c.req.query('api_key');

  // Then check Authorization header
  const authHeader = c.req.header('Authorization');
  let headerToken: string | null = null;

  if (authHeader) {
    const [scheme, token] = authHeader.split(' ');
    if (scheme === 'Bearer' && token) {
      headerToken = token;
    }
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
}

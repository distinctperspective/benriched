import { Context, Next } from 'hono';

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader) {
    return c.json({ error: 'Missing Authorization header' }, 401);
  }

  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer') {
    return c.json({ error: 'Invalid Authorization scheme' }, 401);
  }

  if (!token) {
    return c.json({ error: 'Missing API token' }, 401);
  }

  const validToken = process.env.API_KEY || c.env?.API_KEY;

  if (!validToken) {
    console.warn('API_KEY not configured');
    return c.json({ error: 'API key not configured' }, 500);
  }

  if (token !== validToken) {
    return c.json({ error: 'Invalid API token' }, 401);
  }

  c.set('apiKey', token);
  await next();
}

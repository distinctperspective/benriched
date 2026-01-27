import { Context, Next } from 'hono';

const requestCounts = new Map<string, { count: number; resetTime: number }>();

export async function rateLimitMiddleware(c: Context, next: Next) {
  try {
    const clientId = c.req.header('X-Client-ID') || c.req.header('Authorization') || 'anonymous';
    const now = Date.now();
    const windowMs = 60000;
    const maxRequests = 10;

    let record = requestCounts.get(clientId);

    if (!record || now > record.resetTime) {
      record = { count: 0, resetTime: now + windowMs };
      requestCounts.set(clientId, record);
    }

    if (record.count >= maxRequests) {
      return c.json(
        { error: 'Rate limit exceeded. Max 10 requests per minute.' },
        429
      );
    }

    record.count++;
    try {
      c.header('X-RateLimit-Limit', maxRequests.toString());
      c.header('X-RateLimit-Remaining', (maxRequests - record.count).toString());
      c.header('X-RateLimit-Reset', Math.ceil(record.resetTime / 1000).toString());
    } catch (e) {
      // Ignore header setting errors
    }
  } catch (e) {
    // On Vercel, skip rate limiting if headers can't be accessed
    console.log('Rate limiting skipped due to header access error');
  }

  await next();
}

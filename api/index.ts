import { VercelRequest, VercelResponse } from '@vercel/node';
import app from '../src/index.js';

export default async (req: VercelRequest, res: VercelResponse) => {
  // Convert Vercel request to Fetch API Request
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url || '/', `${protocol}://${host}`);

  const method = req.method || 'GET';
  const headers = new Headers(req.headers as Record<string, string>);

  let body: BodyInit | null = null;
  if (req.body) {
    if (typeof req.body === 'string') {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
    }
  }

  const fetchRequest = new Request(url, {
    method,
    headers,
    body
  });

  try {
    const response = await app.fetch(fetchRequest);

    // Set status
    res.status(response.status);

    // Set headers
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    // Send body
    const text = await response.text();
    res.send(text);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

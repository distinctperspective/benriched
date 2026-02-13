import { Hono } from 'hono';
import enrichRoute from './enrich.js';
import callbackRoute from './callback.js';
import webhooksRoute from './webhooks.js';

const app = new Hono();

app.route('/enrich', enrichRoute);
app.route('/callback', callbackRoute);
app.route('/webhooks', webhooksRoute);

export default app;

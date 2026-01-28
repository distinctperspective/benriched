import { Hono } from 'hono';
import exclusionsRoutes from './exclusions.js';

const app = new Hono();

// Mount exclusions routes
app.route('/exclusions', exclusionsRoutes);

export default app;

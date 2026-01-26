import { Hono } from 'hono';
import contactRouter from './contact.js';

const app = new Hono();

app.route('/contact', contactRouter);

export default app;

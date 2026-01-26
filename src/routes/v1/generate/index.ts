import { Hono } from 'hono';
import emailSequenceRouter from './email-sequence.js';

const app = new Hono();

app.route('/email-sequence', emailSequenceRouter);

export default app;

import { Hono } from 'hono';
import companyRouter from './company.js';
import contactRouter from './contact.js';

const app = new Hono();

app.route('/company', companyRouter);
app.route('/contact', contactRouter);

export default app;

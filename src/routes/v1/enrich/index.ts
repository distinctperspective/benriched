import { Hono } from 'hono';
import companyRouter from './company.js';
import contactRouter from './contact.js';
import contactByIdRouter from './contact-by-id.js';

const app = new Hono();

app.route('/company', companyRouter);
app.route('/contact-by-id', contactByIdRouter);
app.route('/contact', contactRouter);

export default app;

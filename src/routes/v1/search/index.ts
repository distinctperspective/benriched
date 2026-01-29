import { Hono } from 'hono';
import contactsRouter from './contacts.js';
import companiesRouter from './companies.js';

const app = new Hono();

app.route('/contacts', contactsRouter);
app.route('/companies', companiesRouter);

export default app;

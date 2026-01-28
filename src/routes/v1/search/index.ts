import { Hono } from 'hono';
import contactsRouter from './contacts.js';

const app = new Hono();

app.route('/contacts', contactsRouter);

export default app;

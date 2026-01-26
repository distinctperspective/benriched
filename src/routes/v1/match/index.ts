import { Hono } from 'hono';
import personaRouter from './persona.js';

const app = new Hono();

app.route('/persona', personaRouter);

export default app;

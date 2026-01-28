import { Hono } from 'hono';
import enrichRoutes from './enrich/index.js';
import researchRoutes from './research/index.js';
import matchRoutes from './match/index.js';
import generateRoutes from './generate/index.js';
import searchRoutes from './search/index.js';
import healthRoute from './health.js';

const v1 = new Hono();

v1.route('/enrich', enrichRoutes);
v1.route('/research', researchRoutes);
v1.route('/match', matchRoutes);
v1.route('/generate', generateRoutes);
v1.route('/search', searchRoutes);
v1.route('/health', healthRoute);

export default v1;

import { Hono } from 'hono';

const router = new Hono();

router.post('/', async (c) => {
  return c.json({
    message: 'Discover TAM endpoint - coming soon',
    note: 'This endpoint is under development'
  });
});

export default router;

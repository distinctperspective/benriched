import { Hono } from 'hono';
import { Context } from 'hono';
import { supabase } from '../../../lib/supabase.js';
import { AppEnv } from '../../../types.js';

async function handleList(c: Context<AppEnv>) {
  const { data, error } = await supabase
    .from('clay_webhooks')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return c.json({ success: false, error: error.message }, 500);
  }

  return c.json({ success: true, data });
}

async function handleCreate(c: Context<AppEnv>) {
  const body = await c.req.json<{
    name: string;
    webhook_url: string;
    callback_secret?: string;
    cache_ttl_days?: number;
    description?: string;
  }>();

  const { name, webhook_url, callback_secret, cache_ttl_days, description } = body;

  if (!name || !webhook_url) {
    return c.json({ success: false, error: 'name and webhook_url are required' }, 400);
  }

  const { data, error } = await supabase
    .from('clay_webhooks')
    .insert({
      name,
      webhook_url,
      callback_secret: callback_secret || null,
      cache_ttl_days: cache_ttl_days ?? 30,
      description: description || null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return c.json({ success: false, error: `Webhook "${name}" already exists` }, 409);
    }
    return c.json({ success: false, error: error.message }, 500);
  }

  return c.json({ success: true, data }, 201);
}

async function handleUpdate(c: Context<AppEnv>) {
  const body = await c.req.json<{
    id: string;
    name?: string;
    webhook_url?: string;
    callback_secret?: string;
    cache_ttl_days?: number;
    is_enabled?: boolean;
    description?: string;
  }>();

  const { id, ...updates } = body;

  if (!id) {
    return c.json({ success: false, error: 'id is required' }, 400);
  }

  const allowedFields = ['name', 'webhook_url', 'callback_secret', 'cache_ttl_days', 'is_enabled', 'description'];
  const sanitized: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (key in updates) {
      sanitized[key] = (updates as Record<string, unknown>)[key];
    }
  }

  if (Object.keys(sanitized).length === 0) {
    return c.json({ success: false, error: 'No valid fields to update' }, 400);
  }

  const { data, error } = await supabase
    .from('clay_webhooks')
    .update(sanitized)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return c.json({ success: false, error: error.message }, 500);
  }

  return c.json({ success: true, data });
}

async function handleDelete(c: Context<AppEnv>) {
  const id = c.req.query('id');

  if (!id) {
    return c.json({ success: false, error: 'id query parameter is required' }, 400);
  }

  const { error } = await supabase
    .from('clay_webhooks')
    .delete()
    .eq('id', id);

  if (error) {
    return c.json({ success: false, error: error.message }, 500);
  }

  return c.json({ success: true });
}

const app = new Hono();
app.get('/', handleList);
app.post('/', handleCreate);
app.patch('/', handleUpdate);
app.delete('/', handleDelete);

export default app;

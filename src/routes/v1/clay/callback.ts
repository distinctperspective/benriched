import { Hono } from 'hono';
import { Context } from 'hono';
import { supabase } from '../../../lib/supabase.js';

/**
 * POST /v1/clay/callback
 *
 * Receives enriched data from Clay's HTTP API action.
 * Clay sends back the data including the `id` we originally sent as the correlation key.
 * This updates the pending clay_requests row, unblocking the polling loop in enrich().
 *
 * NOTE: This endpoint has NO auth middleware — Clay must be able to call it.
 */
export async function handleClayCallback(c: Context) {
  try {
    const payload = await c.req.json();
    // Clay sends "Id" (capital I) — handle both cases
    const id = payload.id || payload.Id;
    const enrichedData = { ...payload };
    delete enrichedData.id;
    delete enrichedData.Id;

    if (!id) {
      return c.json({ error: "Missing 'id' field in callback payload" }, 400);
    }

    // Look up the pending request
    const { data: existingRequest, error: lookupError } = await supabase
      .from('clay_requests')
      .select('id, webhook_name, status')
      .eq('id', id)
      .single();

    if (lookupError || !existingRequest) {
      console.error(`[Clay Callback] Request not found: ${id}`);
      return c.json({ error: `Request not found: ${id}` }, 404);
    }

    if (existingRequest.status === 'completed') {
      return c.json({ ok: true, message: 'Already completed' });
    }

    // Verify callback secret if provided
    const callbackSecret =
      c.req.header('x-clay-callback-secret') ||
      (payload._callback_secret as string | undefined);

    if (callbackSecret) {
      const { data: webhook } = await supabase
        .from('clay_webhooks')
        .select('callback_secret')
        .eq('name', existingRequest.webhook_name)
        .single();

      if (webhook?.callback_secret && callbackSecret !== webhook.callback_secret) {
        return c.json({ error: 'Invalid callback secret' }, 401);
      }
    }

    // Look up cache TTL from webhook config
    const { data: webhookConfig } = await supabase
      .from('clay_webhooks')
      .select('cache_ttl_days')
      .eq('name', existingRequest.webhook_name)
      .single();

    const cacheTtlDays = webhookConfig?.cache_ttl_days ?? 30;
    const expiresAt = new Date(
      Date.now() + cacheTtlDays * 24 * 60 * 60 * 1000
    ).toISOString();

    // Remove internal fields from stored response
    const cleanedData = { ...enrichedData };
    delete cleanedData._callback_secret;

    // Update the request row — this unblocks the polling loop
    const { error: updateError } = await supabase
      .from('clay_requests')
      .update({
        response_payload: cleanedData,
        status: 'completed',
        completed_at: new Date().toISOString(),
        expires_at: expiresAt,
      })
      .eq('id', id);

    if (updateError) {
      console.error(`[Clay Callback] Failed to update request ${id}:`, updateError);
      return c.json({ error: 'Failed to update request' }, 500);
    }

    console.log(`[Clay Callback] Request ${id} completed`);
    return c.json({ ok: true });
  } catch (error) {
    console.error('[Clay Callback] Error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
}

const app = new Hono();
app.post('/', handleClayCallback);

export default app;

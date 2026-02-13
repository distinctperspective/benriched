import { supabase } from './supabase.js';
import { saveEnrichmentRequest } from './requests.js';

// ─── Types ─────────────────────────────────────────────────────

export interface ClayWebhook {
  id: string;
  name: string;
  webhook_url: string;
  callback_secret: string | null;
  cache_ttl_days: number;
  is_enabled: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export type ClayRequestStatus = 'pending' | 'completed' | 'error';

export interface ClayRequest {
  id: string;
  webhook_name: string;
  lookup_key: string;
  request_payload: Record<string, unknown>;
  response_payload: Record<string, unknown> | null;
  status: ClayRequestStatus;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
}

export interface ClayEnrichResponse {
  result: Record<string, unknown>;
  cached: boolean;
  requestId: string;
}

// ─── Constants ─────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

// ─── Helpers ───────────────────────────────────────────────────

function generateId(): string {
  return `clay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Resolve webhook by name or id ─────────────────────────────

export async function resolveWebhook(nameOrId: string): Promise<ClayWebhook> {
  const { data, error } = await supabase
    .from('clay_webhooks')
    .select('*')
    .or(`name.eq.${nameOrId},id.eq.${nameOrId}`)
    .limit(1)
    .single();

  if (error || !data) {
    throw new Error(`Webhook not found: ${nameOrId}`);
  }

  const webhook = data as unknown as ClayWebhook;

  if (!webhook.is_enabled) {
    throw new Error(`Webhook "${webhook.name}" is disabled`);
  }

  return webhook;
}

// ─── Poll for result ───────────────────────────────────────────

async function pollForResult(
  requestId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ClayRequest> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { data } = await supabase
      .from('clay_requests')
      .select('*')
      .eq('id', requestId)
      .single();

    if (data) {
      const request = data as unknown as ClayRequest;
      if (request.status === 'completed') return request;
      if (request.status === 'error') {
        throw new Error(
          `Clay enrichment failed: ${JSON.stringify(request.response_payload)}`
        );
      }
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Timeout — mark the request as error
  await supabase
    .from('clay_requests')
    .update({ status: 'error', response_payload: { error: 'Polling timeout' } })
    .eq('id', requestId);

  throw new Error(`Clay enrichment timed out after ${timeoutMs / 1000}s`);
}

// ─── Main enrich function ──────────────────────────────────────

export async function enrich(
  webhookNameOrId: string,
  payload: Record<string, unknown>,
  lookupKey: string,
  options?: { forceRefresh?: boolean; timeoutMs?: number }
): Promise<ClayEnrichResponse> {
  const startTime = Date.now();
  const webhook = await resolveWebhook(webhookNameOrId);

  // 1. Check cache (unless forceRefresh)
  if (!options?.forceRefresh) {
    const { data: cached } = await supabase
      .from('clay_requests')
      .select('*')
      .eq('lookup_key', lookupKey)
      .eq('webhook_name', webhook.name)
      .eq('status', 'completed')
      .gt('expires_at', new Date().toISOString())
      .order('completed_at', { ascending: false })
      .limit(1)
      .single();

    if (cached) {
      const cachedRequest = cached as unknown as ClayRequest;

      await saveEnrichmentRequest({
        hs_company_id: `clay_${lookupKey}`,
        domain: lookupKey,
        request_source: 'clay',
        request_type: 'clay_enrich',
        was_cached: true,
        cost_usd: 0,
        response_time_ms: Date.now() - startTime,
        raw_api_responses: {
          webhook: webhook.name,
          cached: true,
          requestId: cachedRequest.id,
        } as any,
      });

      return {
        result: cachedRequest.response_payload!,
        cached: true,
        requestId: cachedRequest.id,
      };
    }
  }

  // 2. Create pending request
  const requestId = generateId();

  const { error: insertError } = await supabase
    .from('clay_requests')
    .insert({
      id: requestId,
      webhook_name: webhook.name,
      lookup_key: lookupKey,
      request_payload: payload,
      status: 'pending',
    });

  if (insertError) {
    throw new Error(`Failed to create Clay request: ${insertError.message}`);
  }

  // 3. POST to Clay webhook
  try {
    const clayResponse = await fetch(webhook.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, id: requestId }),
    });

    if (!clayResponse.ok) {
      const errorText = await clayResponse.text();
      await supabase
        .from('clay_requests')
        .update({
          status: 'error',
          response_payload: { error: `Clay webhook returned ${clayResponse.status}: ${errorText}` },
        })
        .eq('id', requestId);

      throw new Error(`Clay webhook returned ${clayResponse.status}: ${errorText}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Clay webhook returned')) {
      throw err;
    }
    await supabase
      .from('clay_requests')
      .update({
        status: 'error',
        response_payload: { error: `Failed to reach Clay webhook: ${(err as Error).message}` },
      })
      .eq('id', requestId);

    throw new Error(`Failed to reach Clay webhook: ${(err as Error).message}`);
  }

  // 4. Poll for result
  const completed = await pollForResult(
    requestId,
    options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  // 5. Log the request
  await saveEnrichmentRequest({
    hs_company_id: `clay_${lookupKey}`,
    domain: lookupKey,
    request_source: 'clay',
    request_type: 'clay_enrich',
    was_cached: false,
    cost_usd: 0,
    response_time_ms: Date.now() - startTime,
    raw_api_responses: {
      webhook: webhook.name,
      cached: false,
      requestId,
      responsePayload: completed.response_payload,
    } as any,
  });

  return {
    result: completed.response_payload!,
    cached: false,
    requestId,
  };
}

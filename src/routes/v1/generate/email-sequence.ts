import { Hono } from 'hono';
import { Context } from 'hono';
import { generateEmailSequence, EmailSequenceRequest } from '../../../lib/outreach.js';
import { AppEnv } from '../../../types.js';

export async function handleEmailSequenceGeneration(c: Context<AppEnv>) {
  const requestStartTime = Date.now();

  try {
    const body = await c.req.json<EmailSequenceRequest>();
    const { first_name, last_name, full_name, company_name, title, industry, known_trigger, stated_pains } = body;

    // Validate required fields
    if (!company_name) {
      return c.json({ error: 'Missing required field: company_name' }, 400);
    }
    if (!title) {
      return c.json({ error: 'Missing required field: title' }, 400);
    }
    if (!first_name && !last_name && !full_name) {
      return c.json({ error: 'Missing required field: first_name, last_name, or full_name' }, 400);
    }

    console.log(`\n📧 Generating email sequence for ${full_name || `${first_name} ${last_name}`} at ${company_name}`);

    const result = await generateEmailSequence({
      first_name,
      last_name,
      full_name,
      company_name,
      title,
      industry,
      known_trigger,
      stated_pains,
    });

    const responseTimeMs = Date.now() - requestStartTime;
    console.log(`✅ Email sequence generated in ${responseTimeMs}ms`);
    console.log(`💰 Cost: $${result.cost.costUsd.toFixed(4)}`);

    return c.json({
      success: true,
      data: result,
      response_time_ms: responseTimeMs,
    });
  } catch (error) {
    console.error('Email sequence generation error:', error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      },
      500
    );
  }
}

const app = new Hono();
app.post('/', handleEmailSequenceGeneration);

export default app;

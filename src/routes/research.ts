import { Hono } from 'hono';
import { gateway } from '@ai-sdk/gateway';
import { saveEnrichmentRequest, EnrichmentRequestRecord } from '../lib/requests.js';
import { researchContact, ContactResearchRequest } from '../lib/research.js';

const app = new Hono();

interface ResearchContactRequestBody extends ContactResearchRequest {
  api_key?: string;
}

const RESEARCH_MODEL_ID = 'perplexity/sonar-pro';

app.post('/contact', async (c) => {
  const requestStartTime = Date.now();
  
  try {
    const body = await c.req.json<ResearchContactRequestBody>();
    const { prospect_name, company_name, linkedin_url, api_key } = body;

    if (!prospect_name || !company_name) {
      return c.json({ error: 'Missing required fields: prospect_name and company_name' }, 400);
    }

    const perplexityApiKey = c.env?.PERPLEXITY_API_KEY || process.env.PERPLEXITY_API_KEY;
    const apiKey = api_key || c.env?.API_KEY || process.env.API_KEY;

    if (!perplexityApiKey) {
      return c.json({ error: 'Perplexity API key not configured' }, 500);
    }

    if (!apiKey) {
      return c.json({ error: 'API key required' }, 401);
    }

    // Call shared research function with direct Perplexity API
    const result = await researchContact({
      prospect_name,
      company_name,
      linkedin_url
    }, perplexityApiKey);

    const responseTimeMs = Date.now() - requestStartTime;

    // Log the request
    const requestRecord: EnrichmentRequestRecord = {
      hs_company_id: `research_${crypto.randomUUID()}`,
      domain: prospect_name,
      request_source: 'api',
      request_type: 'contact-research',
      was_cached: false,
      cost_usd: result.cost.costUsd,
      response_time_ms: responseTimeMs,
      raw_api_responses: {
        pass1: result.rawResponse,
        pass2: JSON.stringify(result.data)
      },
      enrichment_cost: {
        ai: {
          pass1: {
            model: 'perplexity/sonar-pro',
            inputTokens: result.cost.inputTokens,
            outputTokens: result.cost.outputTokens,
            totalTokens: result.cost.totalTokens,
            costUsd: result.cost.costUsd
          },
          pass2: {
            model: 'perplexity/sonar-pro',
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0
          },
          total: {
            inputTokens: result.cost.inputTokens,
            outputTokens: result.cost.outputTokens,
            totalTokens: result.cost.totalTokens,
            costUsd: result.cost.costUsd
          }
        },
        firecrawl: {
          scrapeCount: 0,
          creditsUsed: 0,
          costUsd: 0
        },
        total: {
          costUsd: result.cost.costUsd
        }
      }
    };

    await saveEnrichmentRequest(requestRecord);

    console.log(`⏱️  Time: ${responseTimeMs}ms`);

    return c.json({
      success: true,
      data: result.data,
      metadata: {
        prospect_name,
        company_name,
        linkedin_url: linkedin_url || null,
        tokens: {
          input: result.cost.inputTokens,
          output: result.cost.outputTokens,
          total: result.cost.totalTokens
        },
        cost_usd: result.cost.costUsd,
        response_time_ms: responseTimeMs
      }
    });
  } catch (error) {
    console.error('Contact research error:', error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      },
      500
    );
  }
});

export default app;

import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { gateway } from '@ai-sdk/gateway';
import { saveEnrichmentRequest, EnrichmentRequestRecord } from '../lib/requests.js';

const app = new Hono();

interface PersonaMatchRequest {
  title: string;
  api_key?: string;
  save_mapping?: boolean; // Whether to save AI match to database
}

interface Persona {
  id: string;
  persona_title: string;
  persona_description: string;
  sample_titles: string;
  description: string;
  responsibilities: string;
  top_priorities: string;
  key_terms: string;
  challenges: string;
  goals: string;
  discovery_questions: string;
  role_in_the_deal: string;
  purchase_needs: string;
  why_they_wont_purchase: string;
  current_scenario: string;
  key_products: string;
  proof_points: string;
  helpful_content: string;
}

interface PersonaMatchResponse {
  title: string;
  matched_from: 'database' | 'ai';
  primary_persona: Persona | null;
  secondary_persona: Persona | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning?: string;
  cost?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
  };
}

// Persona matching prompt
const PERSONA_MATCH_PROMPT = `You are a B2B persona matching expert for manufacturing companies.

Given a job title, match it to the most appropriate persona(s) from the list below.

**TASK**: Analyze the job title and determine:
1. Primary persona (required) - the best fit
2. Secondary persona (optional) - if the role spans multiple personas
3. Confidence level (high/medium/low)
4. Brief reasoning for your choice

**PERSONAS AVAILABLE**:
{{PERSONAS_LIST}}

**MATCHING RULES**:
- Focus on the DEPARTMENT and FUNCTION in the title, not just the seniority level
- Corporate Management persona includes: VP/Director/C-level of ANY department (Finance, HR, Supply Chain, Procurement, Sales, Marketing, etc.)
- Plant Leadership persona: Plant Manager, Plant Director, Operations Manager (site-level operations)
- Operational personas (Quality & EHS, Production, Maintenance): Manager/Director level at the PLANT level for these specific functions
- IT persona: Technology, systems, digital transformation, data roles
- Engineering & CI persona: Manufacturing engineers, process engineers, continuous improvement, lean, automation
- Finance/Accounting/HR/Sales/Marketing/Supply Chain VPs → Corporate Management
- If title clearly spans two personas, include both (primary + secondary)
- Confidence:
  * HIGH: Title clearly matches persona's sample titles or core responsibilities
  * MEDIUM: Title is related but not exact match
  * LOW: Title is ambiguous or doesn't fit well

**EXAMPLES**:
- "VP Finance" → Corporate Management (departmental VP)
- "CFO" → Corporate Management (C-suite)
- "VP of Quality" → Corporate Management (departmental VP)
- "Quality Manager" → Quality & EHS (plant-level operational role)
- "Plant Manager" → Plant Leadership (site operations)
- "Production Manager" → Production (plant-level operational role)

**INPUT**:
Job Title: {{JOB_TITLE}}

**OUTPUT** (JSON only):
{
  "primary_persona_id": "uuid",
  "secondary_persona_id": "uuid or null",
  "confidence": "high|medium|low",
  "reasoning": "Brief explanation of why this persona fits"
}`;

app.post('/', async (c) => {
  const requestStartTime = Date.now();
  
  try {
    const body = await c.req.json<PersonaMatchRequest>();
    const { title, api_key, save_mapping = false } = body;

    if (!title) {
      return c.json({ success: false, error: 'Title is required' }, 400);
    }

    console.log(`\n🎭 Matching persona for title: ${title}`);

    // Step 1: Check if title exists in database
    const { data: existingTitle, error: titleError } = await supabase
      .from('titles')
      .select(`
        *,
        primary:personas!titles_primary_persona_fkey(*),
        secondary:personas!titles_secondary_persona_fkey(*)
      `)
      .ilike('title', title)
      .single();

    if (existingTitle && !titleError) {
      console.log(`   ✅ Found exact match in database`);
      
      const responseTimeMs = Date.now() - requestStartTime;
      
      // Log request to enrichment_requests table
      const requestRecord: EnrichmentRequestRecord = {
        hs_company_id: title, // Use title as identifier for persona requests
        domain: title,
        request_source: 'persona-api',
        request_type: 'persona-match-db',
        was_cached: true,
        cost_usd: 0,
        response_time_ms: responseTimeMs,
        raw_api_responses: {
          pass1: JSON.stringify({
            matched_from: 'database',
            primary_persona_id: existingTitle.primary?.id,
            secondary_persona_id: existingTitle.secondary?.id,
            confidence: 'high'
          })
        }
      };
      
      const { error: requestError } = await saveEnrichmentRequest(requestRecord);
      if (requestError) {
        console.error('   ⚠️  Failed to log request:', requestError);
      } else {
        console.log(`   📝 Logged persona request`);
      }
      
      return c.json({
        success: true,
        data: {
          title,
          matched_from: 'database',
          primary_persona: existingTitle.primary,
          secondary_persona: existingTitle.secondary || null,
          confidence: 'high',
        } as PersonaMatchResponse
      });
    }

    // Step 2: No match found - use AI to match
    console.log(`   🤖 No database match - using AI`);

    // Get all personas
    const { data: personas, error: personasError } = await supabase
      .from('personas')
      .select('*');

    if (personasError || !personas || personas.length === 0) {
      return c.json({ success: false, error: 'Failed to fetch personas' }, 500);
    }

    // Build personas list for prompt
    const personasList = personas.map((p: Persona) => {
      return `ID: ${p.id}
Title: ${p.persona_title}
Description: ${p.persona_description}
Sample Titles: ${p.sample_titles}
Responsibilities: ${p.responsibilities.substring(0, 200)}...`;
    }).join('\n\n---\n\n');

    // Build prompt
    const prompt = PERSONA_MATCH_PROMPT
      .replace('{{PERSONAS_LIST}}', personasList)
      .replace('{{JOB_TITLE}}', title);

    // Call OpenAI via AI Gateway
    const model = gateway('openai/gpt-4o-mini');

    const startTime = Date.now();
    const { text: aiResponse, usage } = await generateText({
      model,
      system: 'You are a B2B persona matching expert. Return only valid JSON.',
      prompt,
      temperature: 0.3,
    });

    const aiTime = Date.now() - startTime;

    if (!aiResponse) {
      return c.json({ success: false, error: 'AI returned empty response' }, 500);
    }

    // Strip markdown code blocks if present
    let cleanedResponse = aiResponse.trim();
    if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    // Parse AI response
    const match = JSON.parse(cleanedResponse);
    console.log(`   🎯 AI matched to: ${match.primary_persona_id} (${match.confidence})`);
    console.log(`   💭 Reasoning: ${match.reasoning}`);

    // Get full persona objects
    const primaryPersona = personas.find((p: Persona) => p.id === match.primary_persona_id);
    const secondaryPersona = match.secondary_persona_id 
      ? personas.find((p: Persona) => p.id === match.secondary_persona_id)
      : null;

    if (!primaryPersona) {
      return c.json({ success: false, error: 'AI returned invalid persona ID' }, 500);
    }

    // Calculate cost (GPT-4o-mini pricing: $0.150/1M input, $0.600/1M output)
    const inputTokens = usage?.inputTokens || 0;
    const outputTokens = usage?.outputTokens || 0;
    const totalTokens = usage?.totalTokens || (inputTokens + outputTokens);
    const inputCost = inputTokens * 0.00000015;
    const outputCost = outputTokens * 0.0000006;
    const totalCost = inputCost + outputCost;

    // Optionally save mapping to database
    if (save_mapping) {
      const { error: insertError } = await supabase
        .from('titles')
        .insert({
          title,
          primary_persona: match.primary_persona_id,
          secondary_persona: match.secondary_persona_id || null,
          notes: `AI matched with ${match.confidence} confidence: ${match.reasoning}`
        });

      if (insertError) {
        console.error('   ⚠️  Failed to save mapping:', insertError);
      } else {
        console.log(`   💾 Saved mapping to database`);
      }
    }

    console.log(`   ⏱️  AI time: ${aiTime}ms`);
    console.log(`   💰 Cost: $${totalCost.toFixed(6)}`);

    const responseTimeMs = Date.now() - requestStartTime;
    
    // Log request to enrichment_requests table
    const requestRecord: EnrichmentRequestRecord = {
      hs_company_id: title, // Use title as identifier for persona requests
      domain: title,
      request_source: 'persona-api',
      request_type: 'persona-match-ai',
      was_cached: false,
      cost_usd: totalCost,
      response_time_ms: responseTimeMs,
      raw_api_responses: {
        pass1: JSON.stringify({
          matched_from: 'ai',
          primary_persona_id: match.primary_persona_id,
          secondary_persona_id: match.secondary_persona_id,
          confidence: match.confidence,
          reasoning: match.reasoning
        })
      },
      enrichment_cost: {
        ai: {
          pass1: {
            model: 'openai/gpt-4o-mini',
            inputTokens,
            outputTokens,
            totalTokens,
            costUsd: totalCost
          },
          total: {
            inputTokens,
            outputTokens,
            totalTokens,
            costUsd: totalCost
          }
        },
        total: {
          costUsd: totalCost
        }
      }
    };
    
    const { error: requestError } = await saveEnrichmentRequest(requestRecord);
    if (requestError) {
      console.error('   ⚠️  Failed to log request:', requestError);
    } else {
      console.log(`   📝 Logged persona request`);
    }

    return c.json({
      success: true,
      data: {
        title,
        matched_from: 'ai',
        primary_persona: primaryPersona,
        secondary_persona: secondaryPersona,
        confidence: match.confidence,
        reasoning: match.reasoning,
        cost: {
          inputTokens,
          outputTokens,
          totalTokens,
          costUsd: totalCost
        }
      } as PersonaMatchResponse
    });

  } catch (error) {
    console.error('Persona matching error:', error);
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

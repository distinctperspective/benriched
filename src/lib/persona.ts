import { createClient } from '@supabase/supabase-js';
import { generateText } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { classifyTier, TierClassificationResult } from './tier.js';

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

export interface PersonaMatchResult {
  title: string;
  matched_from: 'database' | 'ai';
  primary_persona: any;
  secondary_persona: any | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning?: string;
  tier?: string;
  normalized_title?: string;
  cost?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
  };
  tier_cost?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
  };
}

export async function matchPersona(
  title: string,
  supabase: ReturnType<typeof createClient>,
  save_mapping: boolean = false
): Promise<PersonaMatchResult> {
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
    
    // Check if tier is already cached
    if (existingTitle.tier && existingTitle.normalized_title) {
      console.log(`   🏆 Tier cached: ${existingTitle.tier}`);
      return {
        title,
        matched_from: 'database',
        primary_persona: existingTitle.primary,
        secondary_persona: existingTitle.secondary || null,
        confidence: 'high',
        tier: existingTitle.tier,
        normalized_title: existingTitle.normalized_title,
      };
    }
    
    // Tier not cached - classify it
    const tierResult = await classifyTier(title);
    
    // Update database with tier
    await supabase.from('titles')
      .update({
        tier: tierResult.tierLabel,
        normalized_title: tierResult.normalizedTitle
      })
      .eq('id', existingTitle.id);
    
    return {
      title,
      matched_from: 'database',
      primary_persona: existingTitle.primary,
      secondary_persona: existingTitle.secondary || null,
      confidence: 'high',
      tier: tierResult.tierLabel,
      normalized_title: tierResult.normalizedTitle,
      tier_cost: tierResult.cost,
    };
  }

  // Step 2: No match found - use AI
  console.log(`   🤖 No database match - using AI`);

  // Get all personas
  const { data: personas, error: personasError } = await supabase
    .from('personas')
    .select('*');

  if (personasError || !personas || personas.length === 0) {
    throw new Error('Failed to fetch personas from database');
  }

  // Build personas list for prompt
  const personasList = personas.map((p: any) => {
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
    throw new Error('AI returned empty response');
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
  const primaryPersona = personas.find((p: any) => p.id === match.primary_persona_id);
  const secondaryPersona = match.secondary_persona_id 
    ? personas.find((p: any) => p.id === match.secondary_persona_id)
    : null;

  if (!primaryPersona) {
    throw new Error('AI returned invalid persona ID');
  }

  // Calculate cost
  const inputTokens = usage?.inputTokens || 0;
  const outputTokens = usage?.outputTokens || 0;
  const totalTokens = usage?.totalTokens || (inputTokens + outputTokens);
  const inputCost = inputTokens * 0.00000015;
  const outputCost = outputTokens * 0.0000006;
  const totalCost = inputCost + outputCost;

  // Optionally save mapping to database
  if (save_mapping) {
    await supabase.from('titles').insert({
      title,
      primary_persona: match.primary_persona_id,
      secondary_persona: match.secondary_persona_id || null,
      notes: `AI matched with ${match.confidence} confidence: ${match.reasoning}`
    });
    console.log(`   💾 Saved mapping to database`);
  }

  console.log(`   ⏱️  AI time: ${aiTime}ms`);
  console.log(`   💰 Cost: $${totalCost.toFixed(6)}`);

  // Step 3: Classify tier
  const tierResult = await classifyTier(title);

  // Update database with tier if saving mapping
  if (save_mapping) {
    await supabase.from('titles')
      .update({
        tier: tierResult.tierLabel,
        normalized_title: tierResult.normalizedTitle
      })
      .eq('title', title);
  }

  return {
    title,
    matched_from: 'ai',
    primary_persona: primaryPersona,
    secondary_persona: secondaryPersona,
    confidence: match.confidence,
    reasoning: match.reasoning,
    tier: tierResult.tierLabel,
    normalized_title: tierResult.normalizedTitle,
    cost: {
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd: totalCost
    },
    tier_cost: tierResult.cost
  };
}

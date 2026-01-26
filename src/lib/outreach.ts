import { generateText } from 'ai';
import { gateway } from '@ai-sdk/gateway';

export interface EmailSequenceRequest {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  company_name: string;
  title: string;
  industry?: string;
  known_trigger?: string;
  stated_pains?: string[];
}

export interface SubjectLineVariation {
  option1: string;
  option2: string;
  option3: string;
}

export interface EmailContent {
  subject_lines: SubjectLineVariation;
  body: string;
  cta: string;
}

export interface ProofPoint {
  email: number;
  tier: 'Tier 1' | 'Tier 2' | 'Tier 3';
  customer: string;
  metric: string;
  source: string;
}

export interface EmailSequenceResponse {
  success: boolean;
  prospect: {
    name: string;
    title: string;
    company: string;
    seniority_level: string;
  };
  email_1: EmailContent;
  email_2: EmailContent;
  email_3: EmailContent;
  email_4: EmailContent;
  email_5: EmailContent;
  proof_points_used: ProofPoint[];
  cost: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}

// Proof points database - organized by tier and industry
const PROOF_POINTS_DB = {
  'food_manufacturing': {
    tier1: [
      {
        customer: 'JBS Beardstown',
        metric: 'Reduced reporting process by 70 minutes of overtime per shift, resulting in annual savings of $26,554',
        source: 'SafetyChain Case Study',
        industry: 'Protein (Pork) Processing',
        role: 'Quality/Operations'
      },
      {
        customer: 'Blue Buffalo',
        metric: 'Launched QMS in 40 days (50 days ahead of schedule) and logged 2,180 quality records in first week',
        source: 'SafetyChain Case Study',
        industry: 'Pet Food Manufacturing',
        role: 'Quality/Operations'
      }
    ],
    tier2: [
      {
        customer: 'Anonymous Food Manufacturer',
        metric: 'Reduced audit prep time by 60% through centralized documentation',
        source: 'Industry Research',
        industry: 'Food Manufacturing',
        role: 'Quality'
      },
      {
        customer: 'Anonymous Processing Plant',
        metric: 'Eliminated product holds due to documentation delays',
        source: 'Industry Research',
        industry: 'Food Manufacturing',
        role: 'Operations'
      }
    ],
    tier3: [
      {
        customer: 'Aggregated Food Manufacturing',
        metric: 'Regulated food manufacturers average 15-20% of time on compliance documentation vs production',
        source: 'FDA Compliance Data',
        industry: 'Food Manufacturing',
        role: 'Quality'
      }
    ]
  }
};

// Determine seniority level from title
function determineSeniority(title: string): string {
  const titleLower = title.toLowerCase();
  
  if (titleLower.includes('director') || titleLower.includes('vp') || titleLower.includes('vice president') || titleLower.includes('head of')) {
    return 'Director/VP';
  } else if (titleLower.includes('manager') || titleLower.includes('lead')) {
    return 'Manager/Lead';
  } else if (titleLower.includes('supervisor') || titleLower.includes('coordinator')) {
    return 'Supervisor/Coordinator';
  } else if (titleLower.includes('specialist') || titleLower.includes('analyst')) {
    return 'Specialist/Analyst';
  }
  return 'Individual Contributor';
}

// Determine functional area from title
function determineFunctionalArea(title: string): string {
  const titleLower = title.toLowerCase();
  
  if (titleLower.includes('quality') || titleLower.includes('compliance') || titleLower.includes('audit') || titleLower.includes('food safety')) {
    return 'Quality/Compliance';
  } else if (titleLower.includes('operations') || titleLower.includes('production') || titleLower.includes('plant')) {
    return 'Operations';
  } else if (titleLower.includes('it') || titleLower.includes('systems') || titleLower.includes('technology')) {
    return 'IT/PMO';
  }
  return 'Operations';
}

// Select proof point based on hierarchy
function selectProofPoint(functionalArea: string, tier: 'tier1' | 'tier2' | 'tier3'): ProofPoint | null {
  const proofDb = PROOF_POINTS_DB['food_manufacturing'];
  const tierProofs = proofDb[tier];
  
  if (!tierProofs || tierProofs.length === 0) {
    return null;
  }
  
  // Find matching proof point for functional area
  const matching = tierProofs.find(p => p.role.toLowerCase().includes(functionalArea.toLowerCase()));
  const proof = matching || tierProofs[0];
  
  return {
    email: 0, // Will be set by caller
    tier: tier === 'tier1' ? 'Tier 1' : tier === 'tier2' ? 'Tier 2' : 'Tier 3',
    customer: proof.customer,
    metric: proof.metric,
    source: proof.source
  };
}

// Build the system prompt for email generation
function buildSystemPrompt(): string {
  return `You are a specialized outbound sales development assistant for a B2B SaaS company selling into manufacturing, focused on food & beverage, ingredients, quality, operations, compliance, and enterprise IT.

Your job:
1. Generate one high-intent, first-touch intro email
2. Generate a 5-email follow-up cadence

Follow modern outbound best practices (low-volume, signal-based, concrete pain, value-forward).
Goal: reply quality, not volume.

CORE NON-NEGOTIABLE RULES:
- Use ONLY facts, customers, and metrics from the provided knowledge base
- Actively search and match proof for every prospect
- NEVER fabricate customers, metrics, logos, or outcomes
- Copy must be ready to send (no commentary)

FUNCTIONAL & SENIORITY ALIGNMENT (CRITICAL):
Explicitly tie proof and impact to the prospect's role:
- IT / PMO → rollout speed, consolidation, support burden, go-live risk
- Quality → audits, holds, deviations, recalls, documentation load
- Ops → throughput, labor, downtime, rework

FIRST-TOUCH INTRO EMAIL (EMAIL 1):
Objective: Earn a reply that proves relevance now.
Constraints:
- 80–120 words
- 2–3 short paragraphs
- No bullets
- One CTA

Structure:
1. Personalized trigger-based opening
2. One concrete failure mode + impact
3. Explicit buyer exposure (risk, escalation, credibility loss, support burden)
4. Opinion: why this persists despite capable teams/ERP
5. One-sentence proof
6. Specific CTA (benchmark, comparison, pressure-test)

SUBJECT LINE GENERATION:
For every email, generate 3 subject line variations.
Rules:
- ≤10 words
- Specific to the prospect and/or company
- Aligned to that email's single idea and exposure
- No clickbait, emojis, or generic hooks

5-EMAIL FOLLOW-UP CADENCE:
- Same ROLE + INDUSTRY
- Label Email 1–5
- 80–120 words each
- One idea, one CTA
- Max one proof per email

Intent:
- E1: Trigger + exposure
- E2: Deeper failure + proof
- E3: Practical pattern or insight
- E4: Social proof + risk reduction
- E5: Soft breakup + alternate next step

STYLE & GUARDRAILS:
Always:
- Plain, operator language
- Outcome-focused
- Respect seniority

Never:
- Fabricate facts
- Over-personalize
- Multiple CTAs
- Vague phrases without concrete backing`;
}

export async function generateEmailSequence(
  request: EmailSequenceRequest
): Promise<EmailSequenceResponse> {
  const startTime = Date.now();
  
  // Extract prospect name
  const prospectName = request.full_name || `${request.first_name || ''} ${request.last_name || ''}`.trim();
  const seniority = determineSeniority(request.title);
  const functionalArea = determineFunctionalArea(request.title);
  
  // Build user prompt with all context
  const userPrompt = `Generate a complete 5-email outreach sequence for this prospect:

Prospect Name: ${prospectName}
Title: ${request.title}
Company: ${request.company_name}
Industry: ${request.industry || 'Food & Beverage Manufacturing'}
Functional Area: ${functionalArea}
Seniority: ${seniority}
${request.known_trigger ? `Known Trigger: ${request.known_trigger}` : ''}
${request.stated_pains && request.stated_pains.length > 0 ? `Stated Pains: ${request.stated_pains.join(', ')}` : ''}

Available Proof Points:
- Tier 1 (Direct Match): JBS Beardstown - Reduced reporting process by 70 minutes of overtime per shift, resulting in annual savings of $26,554 (SafetyChain Case Study)
- Tier 1 (Direct Match): Blue Buffalo - Launched QMS in 40 days (50 days ahead of schedule) and logged 2,180 quality records in first week (SafetyChain Case Study)
- Tier 2 (Adjacent): Anonymous Food Manufacturer - Reduced audit prep time by 60% through centralized documentation
- Tier 3 (Aggregated): Regulated food manufacturers average 15-20% of time on compliance documentation vs production

Generate the sequence in this JSON format:
{
  "email_1": {
    "subject_lines": {
      "option1": "...",
      "option2": "...",
      "option3": "..."
    },
    "body": "...",
    "cta": "..."
  },
  "email_2": { ... },
  "email_3": { ... },
  "email_4": { ... },
  "email_5": { ... },
  "proof_points_used": [
    {
      "email": 1,
      "tier": "Tier 1",
      "customer": "...",
      "metric": "...",
      "source": "..."
    },
    ...
  ]
}`;

  try {
    const aiGatewayKey = process.env.AI_GATEWAY_API_KEY;
    if (!aiGatewayKey) {
      throw new Error('AI Gateway API key not configured');
    }

    const { text, usage } = await generateText({
      model: gateway('openai/gpt-4-turbo'),
      system: buildSystemPrompt(),
      prompt: userPrompt,
      temperature: 0.7,
    });

    // Parse the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to parse email sequence response');
    }

    const parsedResponse = JSON.parse(jsonMatch[0]);

    // Calculate cost (GPT-4.5-turbo pricing)
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const inputCost = (inputTokens / 1000) * 0.003; // $3 per 1M input tokens
    const outputCost = (outputTokens / 1000) * 0.006; // $6 per 1M output tokens
    const totalCost = inputCost + outputCost;

    return {
      success: true,
      prospect: {
        name: prospectName,
        title: request.title,
        company: request.company_name,
        seniority_level: seniority,
      },
      email_1: parsedResponse.email_1,
      email_2: parsedResponse.email_2,
      email_3: parsedResponse.email_3,
      email_4: parsedResponse.email_4,
      email_5: parsedResponse.email_5,
      proof_points_used: parsedResponse.proof_points_used || [],
      cost: {
        model: 'gpt-4.5-turbo',
        inputTokens,
        outputTokens,
        costUsd: totalCost,
      },
    };
  } catch (error) {
    throw new Error(`Failed to generate email sequence: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

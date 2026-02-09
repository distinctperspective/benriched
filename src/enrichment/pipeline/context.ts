import { Pass1Result, EnrichmentResult, AIUsage } from '../../types.js';
import { SSEEmitter } from '../../lib/sseEmitter.js';
import { DeepResearchResult, OutlierFlags } from '../deepResearch.js';

// ============================================================================
// COST ACCUMULATOR - Tracks AI tokens + Firecrawl credits across stages
// ============================================================================

export class CostAccumulator {
  pass1Usage: AIUsage | null = null;
  pass2Usage: AIUsage | null = null;
  firecrawlCredits: number = 0;
  scrapeCount: number = 0;

  addFirecrawlCredits(credits: number): void {
    this.firecrawlCredits += credits;
  }

  setScrapeCount(count: number): void {
    this.scrapeCount = count;
  }
}

// ============================================================================
// TIMING TRACKER - Tracks milliseconds per stage
// ============================================================================

export class TimingTracker {
  private startTime: number;
  private stageStarts: Map<string, number> = new Map();
  private stageDurations: Map<string, number> = new Map();

  constructor() {
    this.startTime = Date.now();
  }

  start(stage: string): void {
    this.stageStarts.set(stage, Date.now());
  }

  end(stage: string): number {
    const start = this.stageStarts.get(stage);
    if (!start) return 0;
    const duration = Date.now() - start;
    this.stageDurations.set(stage, duration);
    return duration;
  }

  get(stage: string): number {
    return this.stageDurations.get(stage) || 0;
  }

  get totalMs(): number {
    return Date.now() - this.startTime;
  }
}

// ============================================================================
// ENRICHMENT CONTEXT - Shared state that flows through all pipeline stages
// ============================================================================

export interface EnrichmentContext {
  // --- Inputs (set once at creation) ---
  domain: string;
  providedCompanyName?: string;
  providedState?: string;
  providedCountry?: string;
  forceDeepResearch: boolean;
  searchModel: any;
  analysisModel: any;
  searchModelId: string;
  analysisModelId: string;
  firecrawlApiKey?: string;
  emitter?: SSEEmitter;

  // --- Accumulated state (stages read and write these) ---
  enrichmentDomain: string;
  pass1Result: Pass1Result | null;
  pass1RawResponse: string | undefined;
  deepResearchResult: DeepResearchResult | null;
  outlierFlags: OutlierFlags | null;
  scrapedContent: Map<string, string>;
  scrapeResult: { totalCreditsUsed: number; scrapeCount: number } | null;
  linkedinUrl: string | null;
  linkedinSource: 'website' | 'pass1' | null;
  linkedinEmployeeCount: string | null;
  pass2Result: EnrichmentResult | null;
  pass2RawResponse: string | undefined;
  domainResolution: {
    submitted_domain: string;
    resolved_domain: string;
    domain_changed: boolean;
    resolution_method: string;
    credits_used: number;
  } | null;

  // --- Cross-cutting concerns ---
  costs: CostAccumulator;
  timing: TimingTracker;
}

export function createContext(opts: {
  domain: string;
  searchModel: any;
  analysisModel: any;
  firecrawlApiKey?: string;
  searchModelId?: string;
  analysisModelId?: string;
  forceDeepResearch?: boolean;
  emitter?: SSEEmitter;
  providedCompanyName?: string;
  providedState?: string;
  providedCountry?: string;
}): EnrichmentContext {
  return {
    // Inputs
    domain: opts.domain,
    providedCompanyName: opts.providedCompanyName,
    providedState: opts.providedState,
    providedCountry: opts.providedCountry,
    forceDeepResearch: opts.forceDeepResearch || false,
    searchModel: opts.searchModel,
    analysisModel: opts.analysisModel,
    searchModelId: opts.searchModelId || 'perplexity/sonar-pro',
    analysisModelId: opts.analysisModelId || 'openai/gpt-4o-mini',
    firecrawlApiKey: opts.firecrawlApiKey,
    emitter: opts.emitter,

    // Accumulated state
    enrichmentDomain: opts.domain,
    pass1Result: null,
    pass1RawResponse: undefined,
    deepResearchResult: null,
    outlierFlags: null,
    scrapedContent: new Map(),
    scrapeResult: null,
    linkedinUrl: null,
    linkedinSource: null,
    linkedinEmployeeCount: null,
    pass2Result: null,
    pass2RawResponse: undefined,
    domainResolution: null,

    // Cross-cutting
    costs: new CostAccumulator(),
    timing: new TimingTracker(),
  };
}

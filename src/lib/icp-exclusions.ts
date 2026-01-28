import { supabase } from './supabase.js';

export interface IcpExclusionKeyword {
  id: string;
  keyword: string;
  reason: string | null;
  created_at: string;
}

// Cache for exclusion keywords (refreshed on demand)
let cachedKeywords: IcpExclusionKeyword[] | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Load exclusion keywords from database with caching
 */
export async function loadExclusionKeywords(forceRefresh = false): Promise<IcpExclusionKeyword[]> {
  const now = Date.now();

  // Return cached if valid and not forcing refresh
  if (!forceRefresh && cachedKeywords && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedKeywords;
  }

  const { data, error } = await supabase
    .from('icp_exclusion_keywords')
    .select('*')
    .order('keyword');

  if (error) {
    console.error('Failed to load ICP exclusion keywords:', error.message);
    // Return cached data if available, even if stale
    return cachedKeywords || [];
  }

  cachedKeywords = data || [];
  cacheTimestamp = now;

  return cachedKeywords;
}

/**
 * Check if a job title matches any exclusion keyword
 * Returns the matched keyword or null if no match
 */
export function checkExclusion(
  jobTitle: string,
  keywords: IcpExclusionKeyword[]
): IcpExclusionKeyword | null {
  if (!jobTitle) return null;

  const titleLower = jobTitle.toLowerCase();

  return keywords.find(kw =>
    titleLower.includes(kw.keyword.toLowerCase())
  ) || null;
}

/**
 * Add a new exclusion keyword
 */
export async function addExclusionKeyword(
  keyword: string,
  reason?: string
): Promise<{ success: boolean; data?: IcpExclusionKeyword; error?: string; alreadyExists?: boolean }> {
  // Normalize keyword to lowercase
  const normalizedKeyword = keyword.toLowerCase().trim();

  if (!normalizedKeyword) {
    return { success: false, error: 'Keyword cannot be empty' };
  }

  // Check if already exists
  const { data: existing } = await supabase
    .from('icp_exclusion_keywords')
    .select('id')
    .ilike('keyword', normalizedKeyword)
    .single();

  if (existing) {
    return { success: false, alreadyExists: true, error: 'Keyword already exists' };
  }

  const { data, error } = await supabase
    .from('icp_exclusion_keywords')
    .insert({
      keyword: normalizedKeyword,
      reason: reason || null
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  // Invalidate cache
  cachedKeywords = null;

  return { success: true, data };
}

/**
 * Add multiple exclusion keywords at once
 */
export async function addExclusionKeywords(
  keywords: string[],
  reason?: string
): Promise<{ added: string[]; alreadyExists: string[]; errors: string[] }> {
  const added: string[] = [];
  const alreadyExists: string[] = [];
  const errors: string[] = [];

  for (const keyword of keywords) {
    const result = await addExclusionKeyword(keyword, reason);

    if (result.success) {
      added.push(keyword);
    } else if (result.alreadyExists) {
      alreadyExists.push(keyword);
    } else {
      errors.push(`${keyword}: ${result.error}`);
    }
  }

  return { added, alreadyExists, errors };
}

/**
 * Remove an exclusion keyword
 */
export async function removeExclusionKeyword(
  keyword: string
): Promise<{ success: boolean; error?: string }> {
  const normalizedKeyword = keyword.toLowerCase().trim();

  const { error } = await supabase
    .from('icp_exclusion_keywords')
    .delete()
    .ilike('keyword', normalizedKeyword);

  if (error) {
    return { success: false, error: error.message };
  }

  // Invalidate cache
  cachedKeywords = null;

  return { success: true };
}

/**
 * List all exclusion keywords
 */
export async function listExclusionKeywords(): Promise<IcpExclusionKeyword[]> {
  return loadExclusionKeywords(true); // Force refresh for list operations
}

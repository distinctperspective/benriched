export interface DomainResolutionResult {
  submitted_domain: string;
  resolved_domain: string;
  domain_changed: boolean;
  resolution_method: 'search' | 'direct' | 'failed';
  search_results?: any[];
  credits_used: number;
}

/**
 * Resolves an email domain to the actual company website using Firecrawl search.
 * Handles cases where email domains are dead, parked, or different from the main website.
 * 
 * @param domain - The submitted domain (often from email)
 * @param firecrawlApiKey - Firecrawl API key
 * @returns DomainResolutionResult with original and resolved domains
 */
export async function resolveDomainToWebsite(
  domain: string,
  firecrawlApiKey?: string
): Promise<DomainResolutionResult> {
  console.log(`\n🔍 Resolving domain: ${domain}`);
  
  // If no Firecrawl API key, return original domain
  if (!firecrawlApiKey) {
    console.log('   ⚠️  No Firecrawl API key - skipping domain resolution');
    return {
      submitted_domain: domain,
      resolved_domain: domain,
      domain_changed: false,
      resolution_method: 'direct',
      credits_used: 0
    };
  }

  try {
    // Search for the domain to find the actual company website
    const searchQuery = `"${domain}" company website`;
    console.log(`   🔎 Searching: ${searchQuery}`);
    
    const response = await fetch('https://api.firecrawl.dev/v1/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${firecrawlApiKey}`
      },
      body: JSON.stringify({
        query: searchQuery,
        limit: 5
      })
    });

    if (!response.ok) {
      console.error(`   ❌ Firecrawl search failed: ${response.status} ${response.statusText}`);
      return {
        submitted_domain: domain,
        resolved_domain: domain,
        domain_changed: false,
        resolution_method: 'failed',
        credits_used: 0
      };
    }

    const data = await response.json();
    const searchResults = data.data || [];

    if (searchResults.length === 0) {
      console.log('   ⚠️  No search results - using original domain');
      return {
        submitted_domain: domain,
        resolved_domain: domain,
        domain_changed: false,
        resolution_method: 'failed',
        search_results: [],
        credits_used: 1 // Search uses 1 credit
      };
    }

    console.log(`   ✅ Found ${searchResults.length} search results`);
    
    // Extract domains from search results
    const discoveredDomains = new Set<string>();
    for (const result of searchResults) {
      if (result.url) {
        try {
          const url = new URL(result.url);
          const hostname = url.hostname.replace(/^www\./, '');
          discoveredDomains.add(hostname);
        } catch (e) {
          // Invalid URL, skip
        }
      }
    }

    console.log(`   📋 Discovered domains: ${Array.from(discoveredDomains).join(', ')}`);

    // Blacklist social media, platforms, and aggregator sites that should never be resolved to
    const BLACKLISTED_DOMAINS = new Set([
      // Social media
      'linkedin.com',
      'facebook.com',
      'twitter.com',
      'instagram.com',
      'youtube.com',
      'pinterest.com',
      'tiktok.com',
      'reddit.com',
      // News/media
      'wikipedia.org',
      'bloomberg.com',
      'reuters.com',
      'forbes.com',
      // Business data aggregators
      'crunchbase.com',
      'zoominfo.com',
      'apollo.io',
      'dnb.com',
      'owler.com',
      'growjo.com',
      'datanyze.com',
      // Website comparison/aggregator sites - these list OTHER companies, not themselves
      'sitelike.org',
      'similarweb.com',
      'similarsites.com',
      'alternativeto.net',
      'siteslike.com',
      'sitelikethis.com',
      'moreofit.com',
      'alexa.com',
      // Job sites
      'glassdoor.com',
      'indeed.com',
      'ziprecruiter.com',
    ]);

    // Remove blacklisted domains from discovered domains
    const validDomains = Array.from(discoveredDomains).filter(d => !BLACKLISTED_DOMAINS.has(d));

    // Check if the submitted domain appears in results (exact match)
    const submittedDomainNormalized = domain.replace(/^www\./, '');
    if (validDomains.includes(submittedDomainNormalized)) {
      console.log(`   ✅ Submitted domain found in results - using original`);
      return {
        submitted_domain: domain,
        resolved_domain: domain,
        domain_changed: false,
        resolution_method: 'search',
        search_results: searchResults,
        credits_used: 1
      };
    }

    // Check for fuzzy match (submitted domain is similar to discovered domain)
    // Example: willamettehazelnuts.com vs whazelnut.com
    const submittedCore = submittedDomainNormalized.split('.')[0].toLowerCase();
    for (const discoveredDomain of validDomains) {
      const discoveredCore = discoveredDomain.split('.')[0].toLowerCase();
      // If discovered domain is a substring of submitted, or vice versa (with 50%+ overlap)
      if (submittedCore.includes(discoveredCore) || discoveredCore.includes(submittedCore)) {
        const overlapRatio = Math.min(submittedCore.length, discoveredCore.length) / Math.max(submittedCore.length, discoveredCore.length);
        if (overlapRatio >= 0.5) {
          console.log(`   🔄 Fuzzy match found: ${submittedDomainNormalized} ≈ ${discoveredDomain} - using original`);
          return {
            submitted_domain: domain,
            resolved_domain: domain,
            domain_changed: false,
            resolution_method: 'search',
            search_results: searchResults,
            credits_used: 1
          };
        }
      }
    }

    // Look for a primary domain (most common in valid results)
    const domainCounts = new Map<string, number>();
    for (const result of searchResults) {
      if (result.url) {
        try {
          const url = new URL(result.url);
          const hostname = url.hostname.replace(/^www\./, '');
          // Only count non-blacklisted domains
          if (!BLACKLISTED_DOMAINS.has(hostname)) {
            domainCounts.set(hostname, (domainCounts.get(hostname) || 0) + 1);
          }
        } catch (e) {
          // Invalid URL, skip
        }
      }
    }

    // Find the most common domain (likely the canonical one)
    let resolvedDomain = domain;
    let maxCount = 0;
    for (const [discoveredDomain, count] of domainCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        resolvedDomain = discoveredDomain;
      }
    }

    // Only change domain if:
    // 1. We found a different domain
    // 2. That domain appears at least 2 times in results (strong signal)
    // 3. OR if the first search result is from that domain (very strong signal)
    if (resolvedDomain !== submittedDomainNormalized && maxCount >= 2) {
      console.log(`   🔄 Domain resolved: ${domain} → ${resolvedDomain} (appeared ${maxCount} times)`);
      return {
        submitted_domain: domain,
        resolved_domain: resolvedDomain,
        domain_changed: true,
        resolution_method: 'search',
        search_results: searchResults,
        credits_used: 1
      };
    }

    // No different domain found, use original
    console.log(`   ✅ Using original domain: ${domain}`);
    return {
      submitted_domain: domain,
      resolved_domain: domain,
      domain_changed: false,
      resolution_method: 'search',
      search_results: searchResults,
      credits_used: 1
    };

  } catch (error) {
    console.error('   ❌ Domain resolution error:', error);
    // On error, fall back to original domain
    return {
      submitted_domain: domain,
      resolved_domain: domain,
      domain_changed: false,
      resolution_method: 'failed',
      credits_used: 0
    };
  }
}

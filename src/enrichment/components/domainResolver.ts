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
      'x.com',
      'instagram.com',
      'youtube.com',
      'pinterest.com',
      'tiktok.com',
      'reddit.com',
      'threads.net',
      // News/media
      'wikipedia.org',
      'bloomberg.com',
      'reuters.com',
      'forbes.com',
      'wsj.com',
      'nytimes.com',
      'cnbc.com',
      'bbc.com',
      // Business data aggregators
      'crunchbase.com',
      'zoominfo.com',
      'apollo.io',
      'dnb.com',
      'owler.com',
      'growjo.com',
      'datanyze.com',
      'pitchbook.com',
      'cbinsights.com',
      'craft.co',
      'rocketreach.co',
      'lusha.com',
      'clearbit.com',
      // Review / directory / listing sites
      'yelp.com',
      'bbb.org',
      'trustpilot.com',
      'g2.com',
      'capterra.com',
      'yellowpages.com',
      'manta.com',
      'mapquest.com',
      'tripadvisor.com',
      'angi.com',
      'thumbtack.com',
      'foursquare.com',
      // Maps / local
      'google.com',
      'apple.com',
      'bing.com',
      // Website comparison/aggregator sites
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
      'salary.com',
      'payscale.com',
      'levels.fyi',
      'comparably.com',
      // Government / registries
      'sec.gov',
      'opencorporates.com',
      'buzzfile.com',
      // E-commerce platforms (list sellers, not themselves)
      'amazon.com',
      'ebay.com',
      'walmart.com',
      'alibaba.com',
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
    // Example: britt.com → cafebritt.com (user typed shortened version)
    // If we find a match, use the discovered domain (the more complete one)
    const submittedCore = submittedDomainNormalized.split('.')[0].toLowerCase();
    for (const discoveredDomain of validDomains) {
      const discoveredCore = discoveredDomain.split('.')[0].toLowerCase();
      // If discovered domain contains submitted (e.g., "cafebritt" contains "britt")
      // then the discovered domain is likely the full/correct version
      if (discoveredCore.includes(submittedCore) && submittedCore.length >= 4) {
        const overlapRatio = submittedCore.length / discoveredCore.length;
        if (overlapRatio >= 0.5) {
          console.log(`   🔄 Fuzzy match found: ${submittedDomainNormalized} → ${discoveredDomain} - using discovered`);
          return {
            submitted_domain: domain,
            resolved_domain: discoveredDomain,
            domain_changed: true,
            resolution_method: 'search',
            search_results: searchResults,
            credits_used: 1
          };
        }
      }
      // If submitted contains discovered (e.g., "willamettehazelnuts" contains "whazelnut")
      // then submitted is likely more complete, keep original
      if (submittedCore.includes(discoveredCore)) {
        const overlapRatio = discoveredCore.length / submittedCore.length;
        if (overlapRatio >= 0.5) {
          console.log(`   🔄 Fuzzy match found: ${submittedDomainNormalized} ≈ ${discoveredDomain} - keeping submitted (more complete)`);
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
    // 2. That domain appears at least 3 times in results (strong signal from 5 results)
    if (resolvedDomain !== submittedDomainNormalized && maxCount >= 3) {
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

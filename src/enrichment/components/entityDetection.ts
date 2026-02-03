/**
 * Detect if there's a mismatch between the company name from Pass 1
 * and what's actually on the company's website
 */
export function detectEntityMismatch(
  companyName: string,
  domain: string,
  scrapedContent: Map<string, string>
): { mismatch: boolean; signal: 'none' | 'weak' | 'strong' } {
  const companyLower = (companyName || '').toLowerCase();
  const domainBase = domain.replace(/^www\./, '').split('.')[0].toLowerCase();
  const siteText = Array.from(scrapedContent.entries())
    .filter(([url]) => url.includes(domain.replace(/^www\./, '')))
    .map(([, content]) => content)
    .join(' ')
    .toLowerCase();

  if (!siteText) return { mismatch: false, signal: 'none' };

  // Blacklist social media and platform names that appear naturally in content
  // but should never be considered as the actual company name
  const PLATFORM_NAMES = [
    'linkedin', 'facebook', 'twitter', 'instagram', 'youtube',
    'pinterest', 'tiktok', 'reddit', 'wikipedia', 'google',
    'crunchbase', 'bloomberg', 'reuters', 'forbes', 'yelp'
  ];

  // Check if company name is a blacklisted platform
  const isPlatformName = PLATFORM_NAMES.some(platform =>
    companyLower === platform || companyLower.startsWith(platform + ' ')
  );

  // If Pass 1 returned a platform name, that's a strong mismatch signal
  if (isPlatformName) {
    console.log(`   ⚠️  Company name "${companyName}" is a platform/social media name - strong mismatch`);
    return { mismatch: true, signal: 'strong' };
  }

  // Check if company name appears in content (but not as part of social media links)
  const hasCompany = companyLower.length > 3 && siteText.includes(companyLower);
  const hasDomainToken = domainBase.length > 2 && siteText.includes(domainBase);

  // If company name appears, but also check it's not just in social media URLs
  if (hasCompany) {
    // Look for the company name appearing outside of social media context
    const socialMediaContext = [
      'follow us on ' + companyLower,
      'find us on ' + companyLower,
      'connect with us on ' + companyLower,
      'visit us on ' + companyLower,
      companyLower + '.com/company',
      companyLower + '.com/in/'
    ].some(phrase => siteText.includes(phrase));

    if (socialMediaContext && isPlatformName) {
      console.log(`   ⚠️  "${companyName}" only appears in social media context - mismatch`);
      return { mismatch: true, signal: 'strong' };
    }

    return { mismatch: false, signal: 'none' };
  }

  // Company name doesn't appear, but domain token does - strong mismatch
  if (!hasCompany && hasDomainToken) {
    return { mismatch: true, signal: 'strong' };
  }

  // Neither appears - weak mismatch
  if (!hasCompany && !hasDomainToken) {
    return { mismatch: true, signal: 'weak' };
  }

  return { mismatch: false, signal: 'none' };
}

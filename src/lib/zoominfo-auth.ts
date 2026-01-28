// Shared ZoomInfo JWT authentication with token caching
let cachedToken: string | null = null;
let tokenExpiration: number = 0;

/**
 * Parse JWT to extract expiration time
 * Returns expiration timestamp in milliseconds, or 0 if parsing fails
 */
function parseJwtExpiration(jwt: string): number {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return 0;

    // Decode the payload (base64url)
    const payload = parts[1];
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const data = JSON.parse(decoded);

    // JWT exp is in seconds, convert to milliseconds
    if (data.exp) {
      return data.exp * 1000;
    }
    return 0;
  } catch (e) {
    console.log('   Failed to parse JWT expiration:', e);
    return 0;
  }
}

/**
 * Clear the cached token (call this on 401 errors to force re-auth)
 */
export function clearTokenCache(): void {
  console.log('   🔄 Clearing cached JWT token');
  cachedToken = null;
  tokenExpiration = 0;
}

export async function getZoomInfoToken(username: string, password: string, authUrl: string): Promise<string> {
  const now = Date.now();

  // Check if we have a valid cached token
  if (cachedToken && tokenExpiration > now) {
    const hoursRemaining = ((tokenExpiration - now) / (1000 * 60 * 60)).toFixed(1);
    console.log(`   Using cached JWT token (${hoursRemaining}h remaining)`);
    return cachedToken;
  }

  console.log(`   Authenticating with ZoomInfo...`);

  const authResponse = await fetch(authUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username,
      password,
    })
  });

  if (!authResponse.ok) {
    const errorText = await authResponse.text();
    throw new Error(`ZoomInfo auth error: ${authResponse.status} - ${errorText}`);
  }

  const authData = await authResponse.json();

  if (!authData.jwt) {
    throw new Error('No JWT token returned from ZoomInfo auth');
  }

  // Parse the actual JWT expiration
  const jwtExpiration = parseJwtExpiration(authData.jwt);

  if (jwtExpiration > 0) {
    // Use actual JWT expiration minus 5 minutes buffer
    tokenExpiration = jwtExpiration - (5 * 60 * 1000);
    const hoursUntilExpiry = ((jwtExpiration - now) / (1000 * 60 * 60)).toFixed(1);
    console.log(`   Authentication successful (JWT expires in ${hoursUntilExpiry}h)`);
  } else {
    // Fallback: cache for 23.5 hours if we can't parse expiration
    tokenExpiration = now + (23.5 * 60 * 60 * 1000);
    console.log(`   Authentication successful (token cached for 23.5h - fallback)`);
  }

  cachedToken = authData.jwt;
  return authData.jwt;
}

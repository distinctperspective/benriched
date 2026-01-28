// Shared ZoomInfo JWT authentication with token caching
let cachedToken: string | null = null;
let tokenExpiration: number = 0;

export async function getZoomInfoToken(username: string, password: string, authUrl: string): Promise<string> {
  const now = Date.now();
  if (cachedToken && tokenExpiration > now) {
    const hoursRemaining = ((tokenExpiration - now) / (1000 * 60 * 60)).toFixed(1);
    console.log(`   🔑 Using cached JWT token (${hoursRemaining}h remaining)`);
    return cachedToken;
  }

  console.log(`   🔐 Authenticating with ZoomInfo...`);

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

  // Cache the token for 23.5 hours (expires in 24h, refresh 30min early)
  cachedToken = authData.jwt;
  tokenExpiration = now + (23.5 * 60 * 60 * 1000);

  console.log(`   ✅ Authentication successful (token cached for 23.5h)`);
  return authData.jwt;
}

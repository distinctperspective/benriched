import { supabase } from './supabase.js';

// JWT token cache
let cachedToken: string | null = null;
let tokenExpiration: number = 0;

export interface ContactEnrichRequest {
  email: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  job_title?: string;
  company_name?: string;
  hs_company_id?: string;
  hs_contact_id?: string;
}

export interface ZoomInfoContactData {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  mobilePhone?: string;
  directPhone?: string;
  jobTitle?: string;
  managementLevel?: string;
  companyName?: string;
  companyId?: string;
  companyWebsite?: string;
  city?: string;
  state?: string;
  country?: string;
  linkedInUrl?: string;
  externalUrls?: Array<{ type: string; url: string }>;
}

export interface ContactRecord {
  id?: string;
  hubspot_contact_id?: string;
  hubspot_company_id?: string;
  company_id?: string;
  email_address: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  job_title?: string;
  direct_phone?: string;
  cell_phone?: string;
  linked_profile_url?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ContactEnrichResponse {
  success: boolean;
  data?: ContactRecord;
  error?: string;
  was_cached?: boolean;
  credits_used?: number;
  cost?: {
    credits: number;
  };
  rawResponse?: any;
}

async function getZoomInfoToken(username: string, password: string, authUrl: string): Promise<string> {
  // Check if we have a valid cached token
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

export async function enrichContactWithZoomInfo(
  request: ContactEnrichRequest,
  ziUsername: string,
  ziPassword: string,
  ziAuthUrl: string,
  ziEnrichUrl: string
): Promise<ContactEnrichResponse> {
  const { email, full_name, first_name, last_name, job_title, company_name, hs_company_id, hs_contact_id } = request;

  console.log(`\n📧 Enriching contact: ${email}`);

  // Check if contact already exists in database
  const { data: existingContact } = await supabase
    .from('contacts')
    .select('*')
    .eq('email_address', email)
    .single();

  if (existingContact) {
    console.log(`   ✅ Contact already exists in database`);
    return {
      success: true,
      data: existingContact,
      was_cached: true,
    };
  }

  // Get JWT token from ZoomInfo
  const jwtToken = await getZoomInfoToken(ziUsername, ziPassword, ziAuthUrl);

  // Build ZoomInfo API request
  const zoomInfoRequest: any = {
    matchPersonInput: [
      {
        emailAddress: email,
      }
    ],
    outputFields: [
      'id',
      'firstName',
      'lastName',
      'email',
      'phone',
      'mobilePhone',
      'jobTitle',
      'managementLevel',
      'companyName',
      'companyId',
      'companyWebsite',
      'city',
      'state',
      'country',
      'externalUrls',
    ]
  };

  // Add optional fields to improve matching
  if (first_name) zoomInfoRequest.matchPersonInput[0].firstName = first_name;
  if (last_name) zoomInfoRequest.matchPersonInput[0].lastName = last_name;
  if (company_name) zoomInfoRequest.matchPersonInput[0].companyName = company_name;

  console.log(`   🔍 Calling ZoomInfo Enrich API...`);

  // Call ZoomInfo Enrich API
  const response = await fetch(ziEnrichUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwtToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(zoomInfoRequest)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`   ❌ ZoomInfo API error: ${response.status} - ${errorText}`);
    throw new Error(`ZoomInfo API error: ${response.status} - ${errorText}`);
  }

  const zoomInfoResponse = await response.json();
  
  console.log(`   📊 ZoomInfo response received`);

  // Check if we got a successful response
  if (!zoomInfoResponse.success || !zoomInfoResponse.data?.result || zoomInfoResponse.data.result.length === 0) {
    console.log(`   ⚠️  No results from ZoomInfo`);
    return {
      success: false,
      error: 'No match found in ZoomInfo for this email',
    };
  }

  const result = zoomInfoResponse.data.result[0];
  
  // Check match status
  if (result.matchStatus !== 'MATCH' && result.matchStatus !== 'CONFIDENT_MATCH' && result.matchStatus !== 'FULL_MATCH') {
    console.log(`   ⚠️  Match status: ${result.matchStatus}`);
    const errorMsg = result.data?.[0]?.errorMessage || 'No match found';
    return {
      success: false,
      error: `ZoomInfo: ${errorMsg}`,
      rawResponse: zoomInfoResponse,
    };
  }

  // Get the enriched contact data
  if (!result.data || result.data.length === 0) {
    console.log(`   ⚠️  No data in result`);
    return {
      success: false,
      error: 'No contact data returned from ZoomInfo',
      rawResponse: zoomInfoResponse,
    };
  }

  const enrichedData: ZoomInfoContactData = result.data[0];
  const creditsUsed = zoomInfoResponse.creditsUsed || 1;

  console.log(`   ✅ Match found: ${enrichedData.firstName} ${enrichedData.lastName}`);
  console.log(`   💰 Credits used: ${creditsUsed}`);

  // Extract LinkedIn URL from externalUrls array
  let linkedInUrl: string | undefined = undefined;
  if (enrichedData.externalUrls && Array.isArray(enrichedData.externalUrls)) {
    const linkedInEntry = enrichedData.externalUrls.find((urlObj: any) => 
      urlObj.type === 'LINKEDIN' || urlObj.url?.includes('linkedin.com')
    );
    if (linkedInEntry) {
      linkedInUrl = linkedInEntry.url;
      console.log(`   🔗 LinkedIn URL found: ${linkedInUrl}`);
    }
  }

  // Map ZoomInfo data to our contact record format
  const contactRecord: ContactRecord = {
    hubspot_contact_id: hs_contact_id || undefined,
    hubspot_company_id: hs_company_id || undefined,
    email_address: email,
    first_name: enrichedData.firstName || first_name || undefined,
    last_name: enrichedData.lastName || last_name || undefined,
    full_name: enrichedData.firstName && enrichedData.lastName 
      ? `${enrichedData.firstName} ${enrichedData.lastName}` 
      : full_name || undefined,
    job_title: enrichedData.jobTitle || job_title || undefined,
    direct_phone: enrichedData.directPhone || enrichedData.phone || undefined,
    cell_phone: enrichedData.mobilePhone || undefined,
    linked_profile_url: linkedInUrl || undefined,
  };

  // Save to database
  let savedContact;
  let saveError;
  
  if (contactRecord.hubspot_contact_id) {
    // If we have a HubSpot contact ID, upsert using that
    const result = await supabase
      .from('contacts')
      .upsert(contactRecord, { onConflict: 'hubspot_contact_id' })
      .select()
      .single();
    savedContact = result.data;
    saveError = result.error;
  } else {
    // Otherwise, just insert (or check if email exists first)
    const { data: existing } = await supabase
      .from('contacts')
      .select('*')
      .eq('email_address', contactRecord.email_address)
      .single();
    
    if (existing) {
      // Update existing record
      const result = await supabase
        .from('contacts')
        .update(contactRecord)
        .eq('id', existing.id)
        .select()
        .single();
      savedContact = result.data;
      saveError = result.error;
    } else {
      // Insert new record
      const result = await supabase
        .from('contacts')
        .insert(contactRecord)
        .select()
        .single();
      savedContact = result.data;
      saveError = result.error;
    }
  }

  if (saveError) {
    console.error(`   ❌ Error saving contact:`, saveError);
    throw new Error(`Failed to save contact: ${saveError.message}`);
  }

  console.log(`   ✅ Contact saved to database`);

  return {
    success: true,
    data: savedContact,
    was_cached: false,
    credits_used: creditsUsed,
    cost: {
      credits: creditsUsed,
    },
    rawResponse: zoomInfoResponse,
  };
}

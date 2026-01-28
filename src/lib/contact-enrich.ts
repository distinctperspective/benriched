import { supabase } from './supabase.js';
import { getZoomInfoToken, clearTokenCache } from './zoominfo-auth.js';

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
  zoominfo_person_id?: string;
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

export interface ContactEnrichByIdRequest {
  zoominfo_person_id: string;
  hs_contact_id?: string;
  hs_company_id?: string;
  force_refresh?: boolean;
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
  let jwtToken = await getZoomInfoToken(ziUsername, ziPassword, ziAuthUrl);

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

  console.log(`   Calling ZoomInfo Enrich API...`);

  // Call ZoomInfo Enrich API with 401 retry
  let response = await fetch(ziEnrichUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwtToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(zoomInfoRequest)
  });

  // If 401, clear cache, get new token, and retry once
  if (response.status === 401) {
    console.log(`   Got 401, refreshing JWT token...`);
    clearTokenCache();
    jwtToken = await getZoomInfoToken(ziUsername, ziPassword, ziAuthUrl);
    response = await fetch(ziEnrichUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(zoomInfoRequest)
    });
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`   ZoomInfo API error: ${response.status} - ${errorText}`);
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

/**
 * Enrich a contact using ZoomInfo person ID (from contact search results)
 * Creates or updates the contact in the database
 */
export async function enrichContactByZoomInfoId(
  request: ContactEnrichByIdRequest,
  ziUsername: string,
  ziPassword: string,
  ziAuthUrl: string,
  ziEnrichUrl: string
): Promise<ContactEnrichResponse> {
  const { zoominfo_person_id, hs_contact_id, hs_company_id, force_refresh } = request;

  console.log(`\n🔍 Enriching contact by ZoomInfo ID: ${zoominfo_person_id}`);

  // Check if contact already exists in database by zoominfo_person_id
  if (!force_refresh) {
    const { data: existingContact } = await supabase
      .from('contacts')
      .select('*')
      .eq('zoominfo_person_id', zoominfo_person_id)
      .single();

    if (existingContact) {
      console.log(`   ✅ Contact already exists in database`);

      // If HubSpot IDs provided and different, update them
      if ((hs_contact_id && existingContact.hubspot_contact_id !== hs_contact_id) ||
          (hs_company_id && existingContact.hubspot_company_id !== hs_company_id)) {
        const updateData: any = {};
        if (hs_contact_id) updateData.hubspot_contact_id = hs_contact_id;
        if (hs_company_id) updateData.hubspot_company_id = hs_company_id;

        const { data: updatedContact, error: updateError } = await supabase
          .from('contacts')
          .update(updateData)
          .eq('id', existingContact.id)
          .select()
          .single();

        if (!updateError && updatedContact) {
          console.log(`   🔄 Updated HubSpot IDs on existing contact`);
          return {
            success: true,
            data: updatedContact,
            was_cached: true,
          };
        }
      }

      return {
        success: true,
        data: existingContact,
        was_cached: true,
      };
    }
  }

  // Get JWT token from ZoomInfo
  let jwtToken = await getZoomInfoToken(ziUsername, ziPassword, ziAuthUrl);

  // Build ZoomInfo API request using person ID
  const zoomInfoRequest: any = {
    matchPersonInput: [
      {
        personId: zoominfo_person_id,
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

  console.log(`   Calling ZoomInfo Enrich API with person ID...`);

  // Call ZoomInfo Enrich API with 401 retry
  let response = await fetch(ziEnrichUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwtToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(zoomInfoRequest)
  });

  // If 401, clear cache, get new token, and retry once
  if (response.status === 401) {
    console.log(`   Got 401, refreshing JWT token...`);
    clearTokenCache();
    jwtToken = await getZoomInfoToken(ziUsername, ziPassword, ziAuthUrl);
    response = await fetch(ziEnrichUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(zoomInfoRequest)
    });
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`   ZoomInfo API error: ${response.status} - ${errorText}`);
    throw new Error(`ZoomInfo API error: ${response.status} - ${errorText}`);
  }

  const zoomInfoResponse = await response.json();

  console.log(`   📊 ZoomInfo response received`);

  // Check if we got a successful response
  if (!zoomInfoResponse.success || !zoomInfoResponse.data?.result || zoomInfoResponse.data.result.length === 0) {
    console.log(`   ⚠️  No results from ZoomInfo`);
    return {
      success: false,
      error: 'No match found in ZoomInfo for this person ID',
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
  const contactRecord: Partial<ContactRecord> = {
    zoominfo_person_id: zoominfo_person_id,
    hubspot_contact_id: hs_contact_id || undefined,
    hubspot_company_id: hs_company_id || undefined,
    email_address: enrichedData.email || '',
    first_name: enrichedData.firstName || undefined,
    last_name: enrichedData.lastName || undefined,
    full_name: enrichedData.firstName && enrichedData.lastName
      ? `${enrichedData.firstName} ${enrichedData.lastName}`
      : undefined,
    job_title: enrichedData.jobTitle || undefined,
    direct_phone: enrichedData.directPhone || enrichedData.phone || undefined,
    cell_phone: enrichedData.mobilePhone || undefined,
    linked_profile_url: linkedInUrl || undefined,
  };

  // If no email returned, we can't save (email_address is required)
  if (!contactRecord.email_address) {
    console.log(`   ⚠️  No email returned from ZoomInfo - contact cannot be saved`);
    return {
      success: true,
      data: contactRecord as ContactRecord,
      was_cached: false,
      credits_used: creditsUsed,
      cost: { credits: creditsUsed },
      error: 'Contact enriched but no email returned - not saved to database',
      rawResponse: zoomInfoResponse,
    };
  }

  // Save to database - upsert by zoominfo_person_id
  let savedContact;
  let saveError;

  // Check if contact exists by zoominfo_person_id or email
  const { data: existingByZiId } = await supabase
    .from('contacts')
    .select('*')
    .eq('zoominfo_person_id', zoominfo_person_id)
    .single();

  const { data: existingByEmail } = await supabase
    .from('contacts')
    .select('*')
    .eq('email_address', contactRecord.email_address)
    .single();

  const existing = existingByZiId || existingByEmail;

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
    console.log(`   🔄 Updated existing contact`);
  } else {
    // Insert new record
    const result = await supabase
      .from('contacts')
      .insert(contactRecord as ContactRecord)
      .select()
      .single();
    savedContact = result.data;
    saveError = result.error;
    console.log(`   ➕ Created new contact`);
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

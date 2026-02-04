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
  companyId?: string | number;
  companyWebsite?: string;
  company?: { id?: number; name?: string; website?: string };
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

  // ICP fields
  icp_tier?: string;
  icp_tier_rank?: number;
  icp_matched_title?: string;
  is_icp?: boolean;
  icp_exclusion_reason?: string | null;

  // Buying committee fields
  persona?: string | null;              // Persona UUID reference
  persona_label?: string | null;        // Human-readable persona name
  status?: string | null;               // Engagement status: TARGET, LATE STAGE, ENGAGED, EXCLUDED
  reasoning?: string | null;            // Why this contact matters
  engagement_strategy?: string | null;  // How to engage this person
  priority?: string | null;             // "high", "medium", "low"
}

export interface ContactEnrichByIdRequest {
  zoominfo_person_id: string;
  hs_contact_id?: string;
  hs_company_id?: string;
  force_refresh?: boolean;
  update_hubspot?: boolean;  // If true and hs_contact_id provided, update HubSpot contact
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
  hubspot_updated?: boolean;
  hubspot_created?: boolean;
  hubspot_contact_id?: string;
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
 * Build HubSpot properties object from contact data
 * Shared between update and create functions
 */
function buildHubSpotProperties(
  contactData: Partial<ContactRecord>,
  zoomInfoPersonId: string
): Record<string, string> {
  const hubspotProperties: Record<string, string> = {};

  // Contact data fields
  if (contactData.first_name) hubspotProperties.firstname = contactData.first_name;
  if (contactData.last_name) hubspotProperties.lastname = contactData.last_name;
  if (contactData.full_name) hubspotProperties.full_name = contactData.full_name;
  if (contactData.email_address) hubspotProperties.email = contactData.email_address;
  if (contactData.job_title) hubspotProperties.jobtitle = contactData.job_title;
  if (contactData.direct_phone) hubspotProperties.phone_direct__c = contactData.direct_phone;
  if (contactData.cell_phone) hubspotProperties.mobilephone = contactData.cell_phone;
  if (contactData.linked_profile_url) hubspotProperties.boomerang_linkedin_url = contactData.linked_profile_url;
  hubspotProperties.zoom_individual_id = zoomInfoPersonId;

  // Source attribution fields (ZoomInfo enrichment = offline source)
  hubspotProperties.hs_analytics_source = 'OFFLINE';
  hubspotProperties.hs_lead_status = 'NEW';
  hubspotProperties.lifecyclestage = 'lead';

  return hubspotProperties;
}

/**
 * Update a HubSpot contact with enriched data
 * Sets source attribution fields for tracking where the contact data came from
 */
async function updateHubSpotContact(
  contactId: string,
  contactData: Partial<ContactRecord>,
  zoomInfoPersonId: string,
  hubspotToken: string
): Promise<boolean> {
  console.log(`   📤 Updating HubSpot contact ${contactId}...`);

  const hubspotProperties = buildHubSpotProperties(contactData, zoomInfoPersonId);

  try {
    const response = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${hubspotToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ properties: hubspotProperties }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`   ❌ HubSpot update failed: ${response.status} - ${errorText}`);
      return false;
    }

    console.log(`   ✅ HubSpot contact updated`);
    return true;
  } catch (error) {
    console.error(`   ❌ HubSpot update error:`, error);
    return false;
  }
}

/**
 * Create a new HubSpot contact with enriched data
 * Returns the new HubSpot contact ID if successful, null otherwise
 */
async function createHubSpotContact(
  contactData: Partial<ContactRecord>,
  zoomInfoPersonId: string,
  hubspotToken: string,
  hsCompanyId?: string
): Promise<string | null> {
  console.log(`   📤 Creating new HubSpot contact...`);

  // Need at least a name or email to create a HubSpot contact
  if (!contactData.email_address && !contactData.first_name && !contactData.last_name) {
    console.error(`   ❌ Cannot create HubSpot contact without email or name`);
    return null;
  }

  const hubspotProperties = buildHubSpotProperties(contactData, zoomInfoPersonId);

  try {
    const response = await fetch(
      'https://api.hubapi.com/crm/v3/objects/contacts',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${hubspotToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ properties: hubspotProperties }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`   ❌ HubSpot create failed: ${response.status} - ${errorText}`);
      return null;
    }

    const data = await response.json();
    const newContactId = data.id;
    console.log(`   ✅ HubSpot contact created with ID: ${newContactId}`);

    // If we have a company ID, associate the contact with the company
    if (hsCompanyId && newContactId) {
      await associateContactWithCompany(newContactId, hsCompanyId, hubspotToken);
    }

    return newContactId;
  } catch (error) {
    console.error(`   ❌ HubSpot create error:`, error);
    return null;
  }
}

/**
 * Look up a HubSpot company ID by ZoomInfo company ID
 * Searches HubSpot companies where zoominfo_company_id matches
 */
async function lookupHubSpotCompanyByZoomInfoId(
  zoomInfoCompanyId: string,
  hubspotToken: string
): Promise<string | null> {
  console.log(`   🔍 Looking up HubSpot company for ZoomInfo company ID: ${zoomInfoCompanyId}`);

  try {
    const response = await fetch(
      'https://api.hubapi.com/crm/v3/objects/companies/search',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${hubspotToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: 'zoominfo_company_id',
              operator: 'EQ',
              value: zoomInfoCompanyId,
            }]
          }],
          properties: ['name', 'domain', 'zoominfo_company_id'],
          limit: 1,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`   ⚠️  HubSpot company search failed: ${response.status} - ${errorText}`);
      return null;
    }

    const data = await response.json();
    if (data.results && data.results.length > 0) {
      const hsCompanyId = data.results[0].id;
      const companyName = data.results[0].properties?.name || 'Unknown';
      console.log(`   ✅ Found HubSpot company: ${companyName} (ID: ${hsCompanyId})`);
      return hsCompanyId;
    }

    console.log(`   ⚠️  No HubSpot company found for ZoomInfo company ID: ${zoomInfoCompanyId}`);
    return null;
  } catch (error) {
    console.error(`   ⚠️  HubSpot company lookup error:`, error);
    return null;
  }
}

/**
 * Associate a HubSpot contact with a company
 */
async function associateContactWithCompany(
  contactId: string,
  companyId: string,
  hubspotToken: string
): Promise<boolean> {
  console.log(`   🔗 Associating contact ${contactId} with company ${companyId} as PRIMARY...`);

  try {
    // Use v4 API to set company as PRIMARY company
    const response = await fetch(
      `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/company/${companyId}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${hubspotToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: 1, // Type 1 = Primary company
          }
        ]),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`   ⚠️  Primary company association failed: ${response.status} - ${errorText}`);
      return false;
    }

    console.log(`   ✅ Contact associated with company as PRIMARY`);
    return true;
  } catch (error) {
    console.error(`   ⚠️  Association error:`, error);
    return false;
  }
}

/**
 * Enrich a contact using ZoomInfo person ID (from contact search results)
 * Creates or updates the contact in the database
 * Optionally updates the HubSpot contact if hs_contact_id and update_hubspot are provided
 */
export async function enrichContactByZoomInfoId(
  request: ContactEnrichByIdRequest,
  ziUsername: string,
  ziPassword: string,
  ziAuthUrl: string,
  ziEnrichUrl: string,
  hubspotToken?: string
): Promise<ContactEnrichResponse> {
  const { zoominfo_person_id, hs_contact_id, hs_company_id, force_refresh, update_hubspot } = request;

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
  // ZoomInfo may return company data as flat fields OR nested company object
  const ziCompanyId = enrichedData.companyId || enrichedData.company?.id;
  const ziCompanyName = enrichedData.companyName || enrichedData.company?.name;
  if (ziCompanyId) {
    console.log(`   🏢 ZoomInfo company: ${ziCompanyName} (ID: ${ziCompanyId})`);
  }
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

  // If no hs_company_id provided but we have a ZoomInfo company ID, look it up in HubSpot
  let resolvedHsCompanyId = hs_company_id;
  if (!resolvedHsCompanyId && ziCompanyId && update_hubspot && hubspotToken) {
    resolvedHsCompanyId = await lookupHubSpotCompanyByZoomInfoId(
      String(ziCompanyId),
      hubspotToken
    ) || undefined;
  }

  // Map ZoomInfo data to our contact record format
  const contactRecord: Partial<ContactRecord> = {
    zoominfo_person_id: zoominfo_person_id,
    hubspot_contact_id: hs_contact_id || undefined,
    hubspot_company_id: resolvedHsCompanyId || undefined,
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

  // Save to database - upsert by zoominfo_person_id or email
  let savedContact;
  let saveError;

  // Check if contact exists by zoominfo_person_id or email
  const { data: existingByZiId } = await supabase
    .from('contacts')
    .select('*')
    .eq('zoominfo_person_id', zoominfo_person_id)
    .single();

  const existingByEmail = contactRecord.email_address
    ? (await supabase.from('contacts').select('*').eq('email_address', contactRecord.email_address).single()).data
    : null;

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

  // Create or update HubSpot contact if requested
  let hubspotUpdated = false;
  let hubspotCreated = false;
  let newHubspotContactId: string | null = null;

  if (update_hubspot && hubspotToken) {
    if (hs_contact_id) {
      // Update existing HubSpot contact
      hubspotUpdated = await updateHubSpotContact(
        hs_contact_id,
        contactRecord,
        zoominfo_person_id,
        hubspotToken
      );
    } else {
      // Create new HubSpot contact
      newHubspotContactId = await createHubSpotContact(
        contactRecord,
        zoominfo_person_id,
        hubspotToken,
        resolvedHsCompanyId
      );
      hubspotCreated = newHubspotContactId !== null;

      // Update our database record with the new HubSpot contact ID
      if (newHubspotContactId && savedContact) {
        const { data: updatedWithHsId, error: updateHsIdError } = await supabase
          .from('contacts')
          .update({ hubspot_contact_id: newHubspotContactId })
          .eq('id', savedContact.id)
          .select()
          .single();

        if (!updateHsIdError && updatedWithHsId) {
          savedContact = updatedWithHsId;
          console.log(`   🔄 Updated database with new HubSpot contact ID`);
        }
      }
    }
  } else if (update_hubspot && !hubspotToken) {
    console.log(`   ⚠️  update_hubspot=true but no HubSpot token configured`);
  }

  return {
    success: true,
    data: savedContact,
    was_cached: false,
    credits_used: creditsUsed,
    cost: {
      credits: creditsUsed,
    },
    rawResponse: zoomInfoResponse,
    hubspot_updated: hubspotUpdated,
    hubspot_created: hubspotCreated,
    hubspot_contact_id: newHubspotContactId || hs_contact_id || undefined,
  };
}

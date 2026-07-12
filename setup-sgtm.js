const ACCESS_TOKEN = process.env.GOOGLE_TAG_MANAGER_ACCESS_TOKEN;
if (!ACCESS_TOKEN) throw new Error('GOOGLE_TAG_MANAGER_ACCESS_TOKEN is required');
const ACCOUNT_ID = process.env.GTM_ACCOUNT_ID || '6364747837';
const CONTAINER_ID = process.env.GTM_CONTAINER_ID || '257605674';
const WORKSPACE_ID = process.env.GTM_WORKSPACE_ID || '2';
const BASE = `https://tagmanager.googleapis.com/tagmanager/v2/accounts/${ACCOUNT_ID}/containers/${CONTAINER_ID}/workspaces/${WORKSPACE_ID}`;

const CONVERSION_ID = '16698871524';
const CONVERSION_LABEL = 'ejFTCNaVvtIZEOSd0po-';
const GA4_MEASUREMENT_ID = 'G-KBLW70T89R';

async function api(method, path, body) {
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  console.log('=== Creating Event Data Variables ===');
  const keys = [
    'transaction_id', 'value', 'currency', 'gclid',
    'user_data.email_address', 'user_data.phone_number',
    'user_data.address.first_name', 'user_data.address.last_name',
    'user_data.address.country', 'user_data.address.city',
  ];
  for (const key of keys) {
    const v = await api('POST', 'variables', {
      name: `ED - ${key}`,
      type: 'ed',
      parameter: [
        { type: 'template', key: 'keyPath', value: key },
        { type: 'boolean', key: 'setDefaultValue', value: 'false' },
      ],
    });
    console.log(`  OK: ${v.name} (ID: ${v.variableId})`);
  }

  console.log('\n=== Finding Purchase Trigger ===');
  const triggers = (await api('GET', 'triggers')).trigger || [];
  const purchaseTrigger = triggers.find(t => t.name === 'CE - purchase');
  if (!purchaseTrigger) throw new Error('Purchase trigger not found');
  console.log(`  Found: ${purchaseTrigger.name} (ID: ${purchaseTrigger.triggerId})`);

  console.log('\n=== Creating Tags ===');

  const linker = await api('POST', 'tags', {
    name: 'Conversion Linker',
    type: 'sgtmadscl',
    parameter: [
      { type: 'boolean', key: 'enableLinkerParams', value: 'false' },
      { type: 'boolean', key: 'enableCookieOverrides', value: 'false' },
    ],
    firingTriggerId: [purchaseTrigger.triggerId],
    tagFiringOption: 'oncePerEvent',
  });
  console.log(`  OK: ${linker.name} (ID: ${linker.tagId})`);

  const adsTag = await api('POST', 'tags', {
    name: 'GAds - Purchase Conversion',
    type: 'sgtmadsct',
    parameter: [
      { type: 'template', key: 'conversionId', value: CONVERSION_ID },
      { type: 'template', key: 'conversionLabel', value: CONVERSION_LABEL },
      { type: 'boolean', key: 'enableConversionLinker', value: 'true' },
      { type: 'boolean', key: 'enableNewCustomerReporting', value: 'false' },
      { type: 'boolean', key: 'enableProductReporting', value: 'false' },
      { type: 'boolean', key: 'rdp', value: 'false' },
    ],
    firingTriggerId: [purchaseTrigger.triggerId],
    tagFiringOption: 'oncePerEvent',
  });
  console.log(`  OK: ${adsTag.name} (ID: ${adsTag.tagId})`);

  const ga4Tag = await api('POST', 'tags', {
    name: 'GA4 - Purchase Event',
    type: 'sgtmgaaw',
    parameter: [
      { type: 'template', key: 'measurementId', value: GA4_MEASUREMENT_ID },
      { type: 'template', key: 'epToIncludeDropdown', value: 'all' },
      { type: 'template', key: 'upToIncludeDropdown', value: 'all' },
      { type: 'boolean', key: 'redactVisitorIp', value: 'false' },
    ],
    firingTriggerId: [purchaseTrigger.triggerId],
    tagFiringOption: 'oncePerEvent',
  });
  console.log(`  OK: ${ga4Tag.name} (ID: ${ga4Tag.tagId})`);

  console.log('\n=== Creating Container Version ===');
  const version = await api('POST', 'create_version', {
    name: 'sGTM: GAds Conversion + Enhanced Conversions + GA4',
  });
  const versionId = version.containerVersion?.containerVersionId;
  console.log(`  Version: ${versionId}`);

  console.log('\n=== Publishing ===');
  if (!versionId) throw new Error('Tag Manager did not return a container version ID');
  const pubUrl = `https://tagmanager.googleapis.com/tagmanager/v2/accounts/${ACCOUNT_ID}/containers/${CONTAINER_ID}/versions/${versionId}:publish`;
  const pubRes = await fetch(pubUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } });
  const pubData = await pubRes.json().catch(() => ({}));
  if (!pubRes.ok) throw new Error(`Publish failed: ${pubRes.status} ${JSON.stringify(pubData)}`);
  console.log(`  Status: ${pubRes.status}`);
  console.log(`  Published version: ${pubData.containerVersion?.containerVersionId || 'check GTM UI'}`);

  console.log('\n=== DONE ===');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

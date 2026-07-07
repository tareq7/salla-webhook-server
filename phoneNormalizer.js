const crypto = require('crypto');

// Extend as needed if the store serves more than one country
const COUNTRY_CONFIGS = {
  SA: { code: '966', nsnLength: 9 },  // Saudi Arabia
  AE: { code: '971', nsnLength: 9 },  // UAE
  KW: { code: '965', nsnLength: 8 },  // Kuwait
  BH: { code: '973', nsnLength: 8 },  // Bahrain
  QA: { code: '974', nsnLength: 8 },  // Qatar
  OM: { code: '968', nsnLength: 8 },  // Oman
  EG: { code: '20',  nsnLength: 10 }, // Egypt
};

function normalizePhoneE164(rawPhone, countryIso = 'SA') {
  if (!rawPhone) return null;
  const config = COUNTRY_CONFIGS[countryIso];
  if (!config) return null;

  let digits = rawPhone.trim().replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00')) digits = digits.slice(2);

  const { code, nsnLength } = config;
  if (digits.startsWith(code)) {
    digits = digits.slice(code.length);
  } else if (digits.startsWith('0')) {
    digits = digits.slice(1); // strip local trunk prefix, e.g. 0501234567 → 501234567
  }

  if (digits.length !== nsnLength || !/^\d+$/.test(digits)) {
    console.warn(`Phone "${rawPhone}" didn't normalize cleanly for ${countryIso} (got "${digits}")`);
    return null; // fail closed, don't send a guess
  }
  return `+${code}${digits}`;
}

function hashForEnhancedConversions(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

module.exports = { normalizePhoneE164, hashForEnhancedConversions };

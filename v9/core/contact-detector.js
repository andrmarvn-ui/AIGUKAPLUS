const PHONE_CANDIDATE = /(?:\+?84|0)[\s.\-]*(?:\d[\s.\-]*){9,10}/g;
const ZALO_WORD = /\bzalo\b/i;

function normalizeVietnamPhone(candidate) {
  const digits = String(candidate || "").replace(/\D/g, "");
  let local = digits;
  if (digits.startsWith("84")) local = `0${digits.slice(2)}`;
  if (!/^0\d{9}$/.test(local)) return null;
  return local;
}

export function detectContact(text) {
  const value = String(text || "");
  const phones = [];
  for (const match of value.matchAll(PHONE_CANDIDATE)) {
    const phone = normalizeVietnamPhone(match[0]);
    if (phone && !phones.includes(phone)) phones.push(phone);
  }

  const mentionsZalo = ZALO_WORD.test(value);
  return {
    phones,
    primaryPhone: phones[0] || null,
    mentionsZalo,
    hasPhone: phones.length > 0,
    contactCaptured: phones.length > 0,
    evidence: phones.length > 0 ? "phone_in_customer_text" : mentionsZalo ? "zalo_mentioned_without_id" : null,
  };
}

export const __private__ = { normalizeVietnamPhone };

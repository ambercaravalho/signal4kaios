/* Turning a typed phone number into the E.164 form Signal looks numbers up by. */

/** Country calling codes are prefix-free: 1 and 7 are the only one-digit codes, these are the two-digit ones, and every other code has three digits. */
const TWO_DIGIT_CODES = '20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98'.split(' ');

/** The country calling code of an E.164 number, without the "+". */
export function callingCode(e164: string): string {
  const d = e164.replace(/^\+/, '');
  if (d.charAt(0) === '1' || d.charAt(0) === '7') return d.charAt(0);
  if (TWO_DIGIT_CODES.indexOf(d.slice(0, 2)) >= 0) return d.slice(0, 2);
  return d.slice(0, 3);
}

/** The national number without its trunk prefix, the digits dialled before an area code inside the country. Italy keeps its leading 0. */
function dropTrunkPrefix(national: string, cc: string): string {
  if (cc === '1' && national.length === 11 && national.charAt(0) === '1') return national.slice(1);
  if (cc === '7' && national.length === 11 && national.charAt(0) === '8') return national.slice(1);
  if (cc === '36' && national.indexOf('06') === 0) return national.slice(2);
  if (cc !== '39' && national.charAt(0) === '0') return national.slice(1);
  return national;
}

/** `typed` as E.164: "+", "00", and in North America "011" start an international number, and anything else is a number in the same country as `own`, our own E.164 number. */
export function toE164(typed: string, own: string): string {
  const n = typed.replace(/[\s().-]/g, '');
  if (!n) return n;
  if (n.charAt(0) === '+') return n;
  const cc = /^\+\d{6,15}$/.test(own) ? callingCode(own) : '';
  if (cc === '1' && n.indexOf('011') === 0) return '+' + n.slice(3);
  if (n.indexOf('00') === 0) return '+' + n.slice(2);
  if (!cc) return '+' + n;
  return '+' + cc + dropTrunkPrefix(n, cc);
}

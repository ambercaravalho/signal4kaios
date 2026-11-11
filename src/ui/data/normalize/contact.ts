/* Shared contact cards. */

import type { ContactCard } from '../types';
import { str, strings } from './fields';

export function contactCardOf(dm: any): ContactCard | null {
  const c = Array.isArray(dm.contacts) ? dm.contacts[0] : null;
  if (!c || typeof c !== 'object') return null;
  const card: ContactCard = { name: str(c.name).slice(0, 100), phones: strings(c.phones, 5), emails: strings(c.emails, 5) };
  return card.name || card.phones.length || card.emails.length ? card : null;
}

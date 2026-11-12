/* Contacts and groups from the directory, and who is us. */

import { type SyncedContact, syncedContacts, syncedGroups } from '../api';
import { config } from '../config';
import { db } from '../db';
import { dbg } from '../log';
import type { Contact, Conversation, GroupRef } from '../types';
import { persistConv } from './conversations';
import { emit } from './events';
import { contactsByKey, convs, SELF_NAME, state } from './state';

export function self(): string {
  return config.number();
}

/** Whether `key` (a number, an ACI, or a contact key) is us. */
export function isSelf(key: string | undefined): boolean {
  return !!key && isSelfKey(key);
}

export function isSelfKey(key: string): boolean {
  const n = config.number();
  const aci = config.aci();
  if (!key || !n) return false;
  if (key === n || (!!aci && key === aci)) return true;
  const c = contactsByKey[key];
  return !!(c && ((c.number && c.number === n) || (!!aci && c.uuid === aci)));
}

export function isSelfConv(conv: Pick<Conversation, 'id' | 'type'> | undefined | null): boolean {
  return !!(conv && conv.type !== 'group' && isSelfKey(conv.id));
}

export function contactByKey(key: string): Contact | undefined {
  return key ? contactsByKey[key] : undefined;
}

/** A person's name for message authors and member lists; never "Note to Self". */
export function displayName(key: string): string {
  const c = contactByKey(key);
  if (c && c.name && c.name !== SELF_NAME) return c.name;
  return key || '?';
}

export function directName(key: string, fallback: string): string {
  return isSelfKey(key) ? SELF_NAME : fallback;
}

export function altKeyOf(key: string): string | null {
  const c = contactByKey(key);
  if (!c) return null;
  if (c.number && c.number !== key) return c.number;
  if (c.uuid && c.uuid !== key) return c.uuid;
  return null;
}

/** The best name across the places Signal keeps names: nickname or address book, profile, username, then number. */
export function contactName(c: SyncedContact): string {
  if (c.name && c.name !== SELF_NAME) return c.name;
  const nick = c.nickname || {};
  if (nick.name) return nick.name;
  const nn = [nick.given_name, nick.family_name].filter(Boolean).join(' ');
  if (nn) return nn;
  if (c.profile_name) return c.profile_name;
  const p = c.profile || {};
  const pn = [p.given_name, p.lastname].filter(Boolean).join(' ');
  if (pn) return pn;
  return c.username || c.number || c.uuid;
}

export async function refreshDirectory(): Promise<boolean> {
  if (!config.isConfigured()) return false;
  const [contacts, groups] = await Promise.all([syncedContacts(), syncedGroups()]);
  const records: Contact[] = [];
  for (const c of contacts) {
    const rec: Contact = { id: c.uuid || c.number, number: c.number || '', uuid: c.uuid || '', name: contactName(c), blocked: !!c.blocked, hasAvatar: c.profile ? !!c.profile.has_avatar : undefined };
    if (!rec.id) continue;
    if (c.whitelisted !== undefined) rec.whitelisted = !!c.whitelisted || !!c.systemContact;
    records.push(rec);
    if (rec.number) contactsByKey[rec.number] = rec;
    if (rec.uuid) contactsByKey[rec.uuid] = rec;
  }
  db.putContacts(records);

  state.groupsByInternal = {};
  for (const g of groups) {
    if (!g.internal_id) continue;
    const entry: (typeof state.groupsByInternal)[string] = { id: g.id, name: g.name || 'Group' };
    if (g.messageRequest) entry.request = true;
    if (g.addedBy) entry.addedBy = g.addedBy;
    if (typeof g.avatar === 'string') entry.avatar = g.avatar;
    state.groupsByInternal[g.internal_id] = entry;
  }
  db.kvSet('groups', state.groupsByInternal);

  let changed = false;
  for (const conv of Object.values(convs)) {
    if (conv.type === 'group') {
      const g = conv.groupInternalId ? state.groupsByInternal[conv.groupInternalId] : undefined;
      if (g && (conv.name !== g.name || conv.sendId !== g.id || !!conv.request !== !!g.request)) {
        conv.name = g.name;
        conv.sendId = g.id;
        if (g.request) conv.request = true;
        else delete conv.request;
        persistConv(conv);
        changed = true;
      }
    } else {
      const name = directName(conv.id, displayName(conv.id));
      if (name !== conv.id && name !== conv.name) {
        conv.name = name;
        persistConv(conv);
        changed = true;
      }
      const c = conv.request ? contactByKey(conv.id) : undefined;
      if (c && c.whitelisted === true) {
        delete conv.request;
        persistConv(conv);
        changed = true;
      }
    }
  }
  emit('conversations');
  dbg('directory refreshed: ' + records.length + ' contacts, ' + groups.length + ' groups');
  return changed;
}

/** The keys a message by `author` may be stored under; our own messages are stored under our number. */
export function authorKeys(author: string): Array<string | null> {
  return [author, altKeyOf(author), author === config.aci() ? self() : null];
}

/** One key per person for votes: ours is our number, others their number when we know it, else their ACI. */
export function personKey(key: string): string {
  if (key === config.aci() || isSelfKey(key)) return self();
  const c = contactByKey(key);
  return (c && (c.number || c.uuid)) || key;
}

export function contactsList(): Contact[] {
  const seen: Record<string, true> = {};
  const out: Contact[] = [];
  for (const c of Object.values(contactsByKey)) {
    if (seen[c.id]) continue;
    seen[c.id] = true;
    out.push(c);
  }
  return out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export function groupsList(): GroupRef[] {
  return Object.keys(state.groupsByInternal)
    .map((k) => ({ internal_id: k, id: state.groupsByInternal[k].id, name: state.groupsByInternal[k].name }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

/** A group photo's CDN key: '' when the group has none, undefined when it isn't known yet. */
export function groupAvatarKey(internalId: string | undefined): string | undefined {
  const g = internalId ? state.groupsByInternal[internalId] : undefined;
  return g ? g.avatar : undefined;
}

export function selfNumber(): string {
  return self();
}

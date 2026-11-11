/* Row builders and actions shared by the settings screens. */

import { pick } from './Overlays';
import type { ActionRow } from './RowList';
import { toast } from './Toast';
import { EXPIRE_OPTIONS } from '../data/format';
import { friendlyError } from '../errors';
import { S } from '../strings';

/** An on/off row; OK flips it. */
export function toggleRow(key: string, label: string, value: boolean, set: (v: boolean) => void, sub?: string): ActionRow {
  return { key, label, sub, end: 'toggle', checked: value, action: value ? S.turnOff : S.turnOn, onSelect: () => set(!value) };
}

/** Choose a disappearing-message timer; resolves undefined when cancelled. */
export function pickTimer(title: string, current: number): Promise<number | undefined> {
  return pick(title, EXPIRE_OPTIONS.map((o) => ({ value: o.secs, label: o.label })), current);
}

/** Run a change, toast the outcome, and on success run `after`. */
export function runAction(p: Promise<unknown>, done: string, after?: () => void): Promise<void> {
  return p.then(
    () => {
      toast(done);
      if (after) after();
    },
    (e) => toast(friendlyError(e))
  );
}

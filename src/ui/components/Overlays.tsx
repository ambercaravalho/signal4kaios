/* Overlays drawn over the current screen: the KaiOS options menu, dialogs, pickers, and a text prompt. Each resolves a promise and closes itself. */

import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { router, useKeys, useSoftkeys } from '../app/router';
import { S } from '../strings';
import { ActionRow, Row, RowList } from './RowList';
import { TextField } from './TextField';

export interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/** Put between groups of items in `showOptions` to separate them. */
export const DIVIDER = '-';

export type MenuEntry = MenuItem | typeof DIVIDER | null | false | undefined;

/** Drops absent items, then any divider that would sit at an edge or next to another divider. */
export function menuRows(items: MenuEntry[]): Array<MenuItem | typeof DIVIDER> {
  const out: Array<MenuItem | typeof DIVIDER> = [];
  for (const it of items) {
    if (!it) continue;
    if (it === DIVIDER && (!out.length || out[out.length - 1] === DIVIDER)) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1] === DIVIDER) out.pop();
  return out;
}

function OptionsMenuView(props: { title: string; items: Array<MenuItem | typeof DIVIDER> }) {
  const rows: Row[] = props.items.map((it) =>
    it === DIVIDER
      ? { section: '' }
      : {
          label: it.label,
          danger: it.danger,
          onSelect: () => {
            router.pop();
            it.onSelect();
          },
        }
  );
  return (
    <div class="sheet" role="menu">
      <div class="sheet-title">{props.title}</div>
      <div class="sheet-body">
        <RowList rows={rows} compact softkeys={() => ({ left: null, right: null })} />
      </div>
    </div>
  );
}

/** The KaiOS options menu, opened from the right softkey. Absent items are left out, and `DIVIDER` separates groups. */
export function showOptions(items: MenuEntry[], title: string = S.options): void {
  const list = menuRows(items);
  if (list.length) router.overlay(OptionsMenuView, { title, items: list });
}

function DialogView(props: { title: string; body?: ComponentChildren; ok: string; cancel: string | null; danger?: boolean; resolve(v: boolean): void }) {
  const done = (v: boolean) => {
    router.pop();
    props.resolve(v);
  };
  useSoftkeys(props.cancel ? { left: props.cancel, center: null, right: props.ok } : { left: null, center: props.ok, right: null });
  useKeys((e) => {
    if (e.key === 'Enter' || e.key === 'SoftRight' || (!props.cancel && e.key === 'SoftLeft')) done(true);
    else if (e.key === 'SoftLeft' || e.key === 'Backspace') done(false);
    else return false;
    return true;
  });
  return (
    <div class="dialog" role="alertdialog">
      <div class="dialog-title">{props.title}</div>
      {props.body && <div class="dialog-body">{props.body}</div>}
      {props.danger && <div class="dialog-danger-bar" />}
    </div>
  );
}

/** Ask before doing something; resolves true when confirmed. */
export function confirm(opts: { title: string; body?: string; ok?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => router.overlay(DialogView, { title: opts.title, body: opts.body, ok: opts.ok || S.ok, cancel: S.cancel, danger: opts.danger, resolve }));
}

/** Tell the user something that needs acknowledging. */
export function alertDialog(title: string, body?: ComponentChildren): Promise<void> {
  return new Promise((resolve) => router.overlay(DialogView, { title, body, ok: S.ok, cancel: null, resolve: () => resolve() }));
}

export interface PickOption<T> {
  value: T;
  label: string;
  sub?: string;
  /** Classes for a small colored dot before the label. */
  swatch?: string;
}

function PickerView<T>(props: { title: string; options: PickOption<T>[]; value: T; resolve(v: T | undefined): void }) {
  const initial = Math.max(
    0,
    props.options.findIndex((o) => o.value === props.value)
  );
  const rows: ActionRow[] = props.options.map((o) => ({
    label: o.label,
    sub: o.sub,
    leading: o.swatch ? <span class={o.swatch} /> : undefined,
    end: 'radio',
    checked: o.value === props.value,
    onSelect: () => {
      router.pop();
      props.resolve(o.value);
    },
  }));
  useKeys((e) => {
    if (e.key !== 'Backspace' && e.key !== 'SoftLeft') return false;
    router.pop();
    props.resolve(undefined);
    return true;
  });
  return (
    <div class="sheet" role="dialog">
      <div class="sheet-title">{props.title}</div>
      <div class="sheet-body">
        <RowList rows={rows} compact initial={initial} softkeys={() => ({ left: S.cancel, right: null })} />
      </div>
    </div>
  );
}

/** A single choice from a radio list; resolves undefined when cancelled. */
export function pick<T>(title: string, options: PickOption<T>[], value: T): Promise<T | undefined> {
  return new Promise((resolve) => router.overlay(PickerView as any, { title, options, value, resolve }));
}

function MultiPickerView<T>(props: { title: string; options: PickOption<T>[]; values: T[]; resolve(v: T[] | undefined): void }) {
  const [chosen, setChosen] = useState<T[]>(props.values);
  const toggle = (v: T) => setChosen((c) => (c.indexOf(v) >= 0 ? c.filter((x) => x !== v) : c.concat([v])));
  const rows: ActionRow[] = props.options.map((o) => ({ label: o.label, sub: o.sub, end: 'check', checked: chosen.indexOf(o.value) >= 0, onSelect: () => toggle(o.value) }));
  const finish = (v: T[] | undefined) => {
    router.pop();
    props.resolve(v);
  };
  return (
    <div class="sheet" role="dialog">
      <div class="sheet-title">{props.title}</div>
      <div class="sheet-body">
        <RowList
          rows={rows}
          compact
          softkeys={() => ({ left: S.cancel, right: S.done })}
          onKey={(e) => {
            if (e.key === 'SoftRight') finish(chosen);
            else if (e.key === 'SoftLeft' || e.key === 'Backspace') finish(undefined);
            else return false;
            return true;
          }}
        />
      </div>
    </div>
  );
}

/** Several choices from a checkbox list; resolves undefined when cancelled. */
export function pickMany<T>(title: string, options: PickOption<T>[], values: T[]): Promise<T[] | undefined> {
  return new Promise((resolve) => router.overlay(MultiPickerView as any, { title, options, values, resolve }));
}

function PromptView(props: { title: string; value: string; placeholder?: string; hint?: string; type?: 'text' | 'tel'; maxLength?: number; multiline?: boolean; allowEmpty?: boolean; resolve(v: string | undefined): void }) {
  const [value, setValue] = useState(props.value || '');
  const finish = (v: string | undefined) => {
    router.pop();
    props.resolve(v);
  };
  const canSave = props.allowEmpty || value.trim().length > 0;
  useSoftkeys({ left: S.cancel, center: null, right: canSave ? S.save : null });
  useKeys((e) => {
    if (e.key === 'SoftRight' || (e.key === 'Enter' && !props.multiline)) {
      if (canSave) finish(value.trim());
    } else if (e.key === 'SoftLeft' || (e.key === 'Backspace' && !value)) finish(undefined);
    else return false;
    return true;
  });
  return (
    <div class="dialog" role="dialog">
      <div class="dialog-title">{props.title}</div>
      <TextField focused value={value} onInput={setValue} placeholder={props.placeholder} type={props.type} maxLength={props.maxLength} multiline={props.multiline} />
      {props.hint && <div class="dialog-hint">{props.hint}</div>}
    </div>
  );
}

/** Ask for a line of text; resolves the trimmed text, or undefined when cancelled. */
export function prompt(opts: { title: string; value?: string; placeholder?: string; hint?: string; type?: 'text' | 'tel'; maxLength?: number; multiline?: boolean; allowEmpty?: boolean }): Promise<string | undefined> {
  return new Promise((resolve) => router.overlay(PromptView, { ...opts, value: opts.value || '', resolve }));
}

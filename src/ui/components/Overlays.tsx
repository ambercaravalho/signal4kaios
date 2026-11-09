/* Overlays drawn over the current screen: the KaiOS options menu, dialogs, pickers, and a text prompt. Each resolves a promise and closes itself. */

import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { router, useKeys, useSoftkeys } from '../app/router';
import { S } from '../strings';
import { ActionRow, RowList } from './RowList';
import { TextField } from './TextField';

export interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

function OptionsMenuView(props: { title: string; items: MenuItem[] }) {
  const rows: ActionRow[] = props.items.map((it) => ({
    label: it.label,
    danger: it.danger,
    onSelect: () => {
      router.pop();
      it.onSelect();
    },
  }));
  return (
    <div class="sheet" role="menu">
      <div class="sheet-title">{props.title}</div>
      <div class="sheet-body">
        <RowList rows={rows} compact softkeys={() => ({ left: null, right: null })} />
      </div>
    </div>
  );
}

/** The KaiOS options menu, opened from the right softkey. Items with no action are left out. */
export function showOptions(items: Array<MenuItem | null | false | undefined>, title: string = S.options): void {
  const list = items.filter(Boolean) as MenuItem[];
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
}

function PickerView<T>(props: { title: string; options: PickOption<T>[]; value: T; resolve(v: T | undefined): void }) {
  const initial = Math.max(
    0,
    props.options.findIndex((o) => o.value === props.value)
  );
  const rows: ActionRow[] = props.options.map((o) => ({
    label: o.label,
    sub: o.sub,
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

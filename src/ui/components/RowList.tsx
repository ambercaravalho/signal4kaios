import type { ComponentChildren, VNode } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { useListNav } from '../app/focus';
import { SoftkeyLabels, useKeys, useSoftkeys } from '../app/router';
import { S } from '../strings';
import { ListEnd, ListItem, Separator } from './List';

export interface ActionRow {
  key?: string;
  label: string;
  sub?: ComponentChildren;
  meta?: ComponentChildren;
  badge?: ComponentChildren;
  icon?: string;
  leading?: VNode | null;
  end?: ListEnd;
  checked?: boolean;
  danger?: boolean;
  /** The center softkey label when this row is focused; defaults to "Select". */
  action?: string;
  onSelect?: () => void;
}

export type Row = ActionRow | { section: string } | null | false | undefined;

function isAction(r: Row): r is ActionRow {
  return !!r && !('section' in r);
}

/** Which row has focus: the row with the key that had it before, when the rows changed under it rather than the user moving, else where the user moved. A row that's gone leaves focus at the same place. */
export function focusIndex(keys: Array<string | undefined>, navIndex: number, last: { key?: string; navIndex: number }): number {
  if (navIndex !== last.navIndex || last.key === undefined) return navIndex;
  const at = keys.indexOf(last.key);
  return at >= 0 ? at : navIndex;
}

/** A navigable list of rows with section separators. Enter runs the focused row's `onSelect`. The list owns its entry's softkeys: `softkeys` adds left/right labels for the focused row and `onKey` handles them. */
export function RowList(props: {
  rows: Row[];
  compact?: boolean;
  initial?: number;
  empty?: ComponentChildren;
  enabled?: boolean;
  softkeys?: (row: ActionRow | undefined) => SoftkeyLabels;
  onKey?: (e: KeyboardEvent, row: ActionRow | undefined, index: number) => boolean | void;
}) {
  const rows = props.rows.filter(Boolean) as Array<ActionRow | { section: string }>;
  const actions = rows.filter(isAction);
  const nav = useListNav({
    count: actions.length,
    initial: props.initial,
    enabled: props.enabled,
    onEnter: (i) => {
      const r = actions[i];
      if (r && r.onSelect) r.onSelect();
    },
  });
  const last = useRef<{ key?: string; navIndex: number }>({ navIndex: nav.index });
  const index = focusIndex(actions.map((r) => r.key), nav.index, last.current);
  last.current = { key: actions[index] && actions[index].key, navIndex: index };
  useLayoutEffect(() => {
    if (index !== nav.index) nav.setIndex(index);
  });
  const row = actions[index];
  const extra = props.softkeys ? props.softkeys(row) : {};
  useSoftkeys({ center: row && row.onSelect ? row.action || S.select : null, ...extra });
  useKeys((e) => (props.onKey ? props.onKey(e, row, index) : false));

  if (!actions.length && props.empty) return <>{props.empty}</>;
  let n = -1;
  return (
    <div class="list" role="listbox">
      {rows.map((r, i) => {
        if (!isAction(r)) return <Separator key={'s' + i} label={r.section} />;
        n += 1;
        return (
          <ListItem
            key={r.key || r.label + i}
            focused={n === index}
            primary={r.label}
            secondary={r.sub}
            meta={r.meta}
            badge={r.badge}
            icon={r.icon}
            leading={r.leading}
            end={r.end}
            checked={r.checked}
            danger={r.danger}
            compact={props.compact}
            first={n === 0}
          />
        );
      })}
    </div>
  );
}

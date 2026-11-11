import type { ComponentChildren } from 'preact';
import { useListNav } from '../app/focus';
import { useKeys, useSoftkeys } from '../app/router';
import type { Contact, GroupRef } from '../data/types';
import { S } from '../strings';
import { Avatar } from './Avatar';
import { ListItem, Separator } from './List';
import type { ActionRow, Row } from './RowList';
import { Screen } from './Screen';
import { TextField } from './TextField';

/** A search field above a list of results. Up and Down move between them; OK on the field jumps into the results. */
export function SearchList(props: { title: string; placeholder: string; query: string; onQuery(q: string): void; rows: Row[]; empty?: ComponentChildren; right?: string | null; onRight?(): void }) {
  const rows = props.rows.filter(Boolean) as Array<ActionRow | { section: string }>;
  const actions = rows.filter((r) => !('section' in r)) as ActionRow[];
  const nav = useListNav({
    count: actions.length + 1,
    onEnter: (i) => {
      if (i === 0) {
        if (actions.length) nav.setIndex(1);
        return;
      }
      const r = actions[i - 1];
      if (r && r.onSelect) r.onSelect();
    },
  });
  const row = nav.index > 0 ? actions[nav.index - 1] : undefined;
  useSoftkeys({ center: row ? row.action || S.select : null, right: props.right });
  useKeys((e) => {
    if (e.key !== 'SoftRight' || !props.onRight) return false;
    props.onRight();
    return true;
  });
  let n = 0;
  return (
    <Screen title={props.title}>
      <TextField focused={nav.index === 0} value={props.query} onInput={props.onQuery} placeholder={props.placeholder} />
      {!actions.length && props.empty}
      <div class="list" role="listbox">
        {rows.map((r, i) => {
          if ('section' in r) return <Separator key={'s' + i} label={r.section} />;
          n += 1;
          return <ListItem key={r.key || r.label + i} focused={n === nav.index} primary={r.label} secondary={r.sub} meta={r.meta} leading={r.leading} icon={r.icon} />;
        })}
      </div>
    </Screen>
  );
}

export function contactRow(c: Contact, onSelect: () => void): ActionRow {
  const name = c.name || c.number || S.unknown;
  return { key: 'c:' + c.id, label: name, sub: c.number && c.number !== name ? c.number : undefined, leading: <Avatar conv={{ id: c.id, type: 'direct', name }} />, onSelect };
}

export function groupRow(g: GroupRef, onSelect: () => void): ActionRow {
  return { key: 'g:' + g.internal_id, label: g.name || S.group, leading: <Avatar conv={{ id: 'g:' + g.internal_id, type: 'group', name: g.name, groupInternalId: g.internal_id }} />, onSelect };
}

export function matches(hay: string | undefined, q: string): boolean {
  return !!hay && hay.toLowerCase().indexOf(q) >= 0;
}

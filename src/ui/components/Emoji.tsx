import groups from 'unicode-emoji-json/data-by-group.json';
import { useMemo, useState } from 'preact/hooks';
import { useFocusScroll, useListNav } from '../app/focus';
import { router, useKeys, useSoftkeys } from '../app/router';
import { SKIN_TONES, withSkinTone } from '../data/styled';
import { S } from '../strings';
import { pick, showOptions } from './Overlays';
import { Screen } from './Screen';

/** Signal's default reactions. */
export const QUICK_REACTIONS = ['❤️', '👍', '👎', '😂', '😮', '😢'];

const COLS = 6;
/** The newest emoji release the KaiOS 3.x system emoji font can draw; matches `MAX_EMOJI_VERSION` in scripts/build.mjs. */
const MAX_EMOJI_VERSION = 12.1;
const SKIN_TONE_KEY = 's4k.emojiSkinTone';
const RECENT_KEY = 's4k.emojiRecent';
const MAX_RECENT = 24;

function recent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function remember(e: string): void {
  localStorage.setItem(RECENT_KEY, JSON.stringify([e].concat(recent().filter((x) => x !== e)).slice(0, MAX_RECENT)));
}

const CATEGORY_LABELS: Record<string, string> = {
  smileys_emotion: 'Smileys',
  people_body: 'People',
  animals_nature: 'Animals',
  food_drink: 'Food',
  travel_places: 'Travel',
  activities: 'Activities',
  objects: 'Objects',
  symbols: 'Symbols',
  flags: 'Flags',
};

interface Category {
  id: string;
  label: string;
  emojis: string[];
}

/** Index into `SKIN_TONES`; 0 is the default yellow. */
function skinTone(): number {
  const n = parseInt(localStorage.getItem(SKIN_TONE_KEY) || '0', 10);
  return n > 0 && n < SKIN_TONES.length ? n : 0;
}

interface EmojiEntry {
  emoji: string;
  emoji_version: string;
  skin_tone_support?: boolean;
  skin_tone_support_unicode_version?: string;
}

function categories(tone: number): Category[] {
  const list: Category[] = [];
  const r = recent();
  if (r.length) list.push({ id: 'recent', label: S.recentEmoji, emojis: r });
  const mod = SKIN_TONES[tone] || '';
  for (const g of groups as Array<{ slug: string; name: string; emojis: EmojiEntry[] }>) {
    const emojis = g.emojis
      .filter((e) => parseFloat(e.emoji_version) <= MAX_EMOJI_VERSION)
      .map((e) => (mod && e.skin_tone_support && parseFloat(e.skin_tone_support_unicode_version || '99') <= MAX_EMOJI_VERSION ? withSkinTone(e.emoji, mod) : e.emoji));
    if (emojis.length) list.push({ id: g.slug, label: CATEGORY_LABELS[g.slug] || g.name, emojis });
  }
  return list;
}

const SKIN_TONE_LABELS = [S.skinToneDefault, S.skinToneLight, S.skinToneMediumLight, S.skinToneMedium, S.skinToneMediumDark, S.skinToneDark];

function chooseSkinTone(): Promise<number | undefined> {
  return pick(
    S.skinTone,
    SKIN_TONES.map((t, i) => ({ value: i, label: withSkinTone('✋', t) + ' ' + SKIN_TONE_LABELS[i] })),
    skinTone()
  ).then((i) => {
    if (i !== undefined) localStorage.setItem(SKIN_TONE_KEY, String(i));
    return i;
  });
}

function Cell(props: { emoji: string; focused: boolean }) {
  const ref = useFocusScroll<HTMLDivElement>(props.focused);
  return (
    <div class={'emoji-cell' + (props.focused ? ' focused' : '')} ref={ref}>
      {props.emoji}
    </div>
  );
}

/** A grid of emoji; Enter picks the focused one. */
export function EmojiGrid(props: { emojis: string[]; onPick(e: string): void }) {
  const nav = useListNav({ count: props.emojis.length, cols: COLS, onEnter: (i) => props.onPick(props.emojis[i]) });
  return (
    <div class="emoji-grid">
      {props.emojis.map((e, i) => (
        <Cell key={e + i} emoji={e} focused={i === nav.index} />
      ))}
    </div>
  );
}

function EmojiScreen(props: { title: string; resolve(e: string | undefined): void }) {
  const [tone, setTone] = useState(skinTone);
  const cats = useMemo(() => categories(tone), [tone]);
  const [catId, setCatId] = useState(cats[0].id);
  const c = cats.find((x) => x.id === catId) || cats[0];
  const finish = (e: string | undefined) => {
    router.pop();
    if (e) remember(e);
    props.resolve(e);
  };
  const chooseCategory = () =>
    pick(
      S.category,
      cats.map((x) => ({ value: x.id, label: x.label })),
      c.id
    ).then((id) => {
      if (id !== undefined) setCatId(id);
    });
  useSoftkeys({ left: S.cancel, center: S.select, right: S.options });
  useKeys((e) => {
    if (e.key === 'SoftLeft') finish(undefined);
    else if (e.key === 'SoftRight')
      showOptions([
        { label: S.category, onSelect: chooseCategory },
        {
          label: S.skinTone,
          onSelect: () =>
            chooseSkinTone().then((i) => {
              if (i !== undefined) setTone(i);
            }),
        },
      ]);
    else return false;
    return true;
  });
  return (
    <Screen title={props.title + ' · ' + c.label}>
      <EmojiGrid key={c.id + tone} emojis={c.emojis} onPick={finish} />
    </Screen>
  );
}

/** Choose any emoji from the full picker; resolves undefined when cancelled. */
export function pickEmoji(title: string = S.emoji): Promise<string | undefined> {
  return new Promise((resolve) => router.push(EmojiScreen, { title, resolve }));
}

function ReactionBar(props: { current: string | null; resolve(e: string | null | undefined): void }) {
  const items = QUICK_REACTIONS.concat(['…']);
  const initial = Math.max(0, props.current ? QUICK_REACTIONS.indexOf(props.current) : 0);
  const finish = (e: string | null | undefined) => {
    router.pop();
    props.resolve(e);
  };
  const nav = useListNav({
    count: items.length,
    cols: items.length,
    initial,
    onEnter: (i) => {
      const e = items[i];
      if (e === '…') {
        router.pop();
        pickEmoji(S.react).then((x) => props.resolve(x));
      } else finish(e === props.current ? null : e);
    },
  });
  useSoftkeys({ left: S.cancel, center: S.select, right: props.current ? S.removeReaction : null });
  useKeys((e) => {
    if (e.key === 'SoftLeft') finish(undefined);
    else if (e.key === 'SoftRight' && props.current) finish(null);
    else return false;
    return true;
  });
  return (
    <div class="reaction-bar" role="menu">
      {items.map((e, i) => (
        <div key={e} class={'reaction-choice' + (i === nav.index ? ' focused' : '') + (e === props.current ? ' chosen' : '')}>
          {e}
        </div>
      ))}
    </div>
  );
}

/** Signal's reaction bar over the chat; resolves the emoji, null to remove the reaction, or undefined when cancelled. */
export function pickReaction(current: string | null): Promise<string | null | undefined> {
  return new Promise((resolve) => router.overlay(ReactionBar, { current, resolve }));
}

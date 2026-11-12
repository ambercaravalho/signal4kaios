/* Signal's chat bubble colors (Signal-Desktop AxoTokens.ChatBubble), in `ChatStyle.BubbleColorPreset` order: preset N is `CHAT_COLORS[N - 1]`. Each one is a `chat-color-<name>` class in theme/screens.css. */

import { CHAT_COLOR_NAMES, fmt, S } from '../strings';
import { config } from './config';
import type { Conversation } from './types';

export const CHAT_COLORS = [
  'ultramarine',
  'crimson',
  'vermilion',
  'burlap',
  'forest',
  'wintergreen',
  'teal',
  'blue',
  'indigo',
  'violet',
  'plum',
  'taupe',
  'steel',
  'ember',
  'midnight',
  'infrared',
  'lagoon',
  'fluorescent',
  'basil',
  'sublime',
  'sea',
  'tangerine',
] as const;

export type ChatColor = (typeof CHAT_COLORS)[number];
export const AUTOMATIC = 'automatic';
export type ChatColorChoice = ChatColor | typeof AUTOMATIC;

export function isChatColor(v: unknown): v is ChatColor {
  return typeof v === 'string' && (CHAT_COLORS as readonly string[]).indexOf(v) >= 0;
}

export function defaultChatColor(): ChatColorChoice {
  const v = config.chatColor();
  return isChatColor(v) ? v : AUTOMATIC;
}

/** The chat's own color, else the default. */
export function chatColorOf(conv: Pick<Conversation, 'chatColor'> | undefined): ChatColorChoice {
  return conv && isChatColor(conv.chatColor) ? conv.chatColor : defaultChatColor();
}

export function chatColorClass(c: ChatColorChoice): string {
  return c === AUTOMATIC ? '' : 'chat-color-' + c;
}

export function chatColorLabel(c: ChatColorChoice): string {
  return c === AUTOMATIC ? S.chatColorAutomatic : CHAT_COLOR_NAMES[c];
}

function swatch(c: ChatColorChoice): string {
  return c === AUTOMATIC ? 'swatch' : 'swatch ' + chatColorClass(c);
}

/** Picker rows: `first` (automatic, or the chat's "follow the default"), then every preset, each with its swatch. */
export function chatColorOptions<T extends string>(first: { value: T; label: string; swatch: ChatColorChoice }): Array<{ value: T | ChatColor; label: string; swatch: string }> {
  return [{ value: first.value as T | ChatColor, label: first.label, swatch: swatch(first.swatch) }].concat(CHAT_COLORS.map((c) => ({ value: c, label: CHAT_COLOR_NAMES[c], swatch: swatch(c) })));
}

/** The label for a chat that follows the default. */
export function followDefaultLabel(): string {
  return fmt(S.chatColorDefault, { name: chatColorLabel(defaultChatColor()) });
}

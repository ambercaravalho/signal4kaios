import type { RefObject } from 'preact';
import { useKeys, useSoftkeys } from '../../app/router';
import type { Message } from '../../data/types';
import { S } from '../../strings';
import type { useChatComposer } from './useChatComposer';

/** How far Up and Down scroll through a message taller than the screen before focus moves on. */
const STEP_PX = 60;

export interface ChatKeysOptions {
  listRef: RefObject<HTMLDivElement | null>;
  msgs: Message[];
  focusedId: string | null;
  setFocusedId(id: string | null): void;
  hasMore: boolean;
  loadOlder(): Promise<Message[]>;
  composer: ReturnType<typeof useChatComposer>;
  blocked: boolean;
  request: boolean;
  canCompose: boolean;
  unblock(): void;
  acceptRequest(): void;
  messageOptions(m: Message): void;
  chatOptions(): void;
}

/** A chat's keys: Up and Down move between messages and the composer, OK sends or opens a message's options. Returns whether focus is on the composer. */
export function useChatKeys(o: ChatKeysOptions): boolean {
  const { msgs, composer } = o;
  const { draft, quote, editing, tray } = composer;
  const index = o.focusedId === null ? -1 : msgs.findIndex((m) => m.id === o.focusedId);
  const onComposer = index < 0;

  /** Scrolls a step through the focused message when it doesn't fit, so its hidden edge comes into view before focus moves. */
  function stepThroughTall(down: boolean): boolean {
    const list = o.listRef.current;
    const el = list && (list.querySelector('.msg.focused') as HTMLElement | null);
    if (!list || !el) return false;
    const view = list.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const hidden = down ? r.bottom - view.bottom : view.top - r.top;
    if (hidden <= 1) return false;
    list.scrollTop += (down ? 1 : -1) * Math.min(STEP_PX, hidden);
    return true;
  }

  useKeys((e) => {
    switch (e.key) {
      case 'ArrowUp': {
        if (onComposer) {
          const el = composer.inputRef.current;
          if (el && el.selectionStart) return false;
          if (msgs.length) o.setFocusedId(msgs[msgs.length - 1].id);
          return true;
        }
        if (stepThroughTall(false)) return true;
        if (index > 0) o.setFocusedId(msgs[index - 1].id);
        else if (o.hasMore)
          o.loadOlder().then((rows) => {
            if (rows.length) o.setFocusedId(rows[rows.length - 1].id);
          });
        return true;
      }
      case 'ArrowDown':
        if (onComposer) return false;
        if (stepThroughTall(true)) return true;
        o.setFocusedId(index < msgs.length - 1 ? msgs[index + 1].id : null);
        return true;
      case 'Enter':
        if (onComposer) {
          if (o.blocked) o.unblock();
          else if (o.request) o.acceptRequest();
          else if (o.canCompose) composer.submit();
        } else o.messageOptions(msgs[index]);
        return true;
      case 'SoftRight':
        o.chatOptions();
        return true;
      case 'SoftLeft':
        if (!quote && !editing) return false;
        composer.clearContext();
        return true;
      case 'Backspace':
        if (!onComposer) {
          o.setFocusedId(null);
          return true;
        }
        if (draft || (!quote && !editing)) return false;
        composer.clearContext();
        return true;
    }
    return false;
  });

  useSoftkeys({
    left: quote || editing ? S.cancel : undefined,
    center: onComposer ? (o.blocked ? S.unblock : o.request ? S.accept : o.canCompose && (draft.trim() || tray.length) ? (editing ? S.save : S.send) : null) : S.select,
    right: S.options,
  });

  return onComposer;
}

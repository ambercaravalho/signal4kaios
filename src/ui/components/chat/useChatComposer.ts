import { useEffect, useRef, useState } from 'preact/hooks';
import { groupDetail, signal } from '../../data/api';
import { readDataUri } from '../../data/attachments';
import { photoBlurHash } from '../../data/blurhash';
import { config } from '../../data/config';
import { type FetchedPreview, fetchLinkPreview, previewCandidate } from '../../data/link-preview-fetch';
import { chooseFile } from '../../data/platform';
import * as store from '../../data/store';
import type { PickedMention } from '../../data/styled';
import type { Conversation, Message, Quote } from '../../data/types';
import { voiceNoteFile } from '../../data/voice-recorder';
import { sendError } from '../../errors';
import { fmt, S } from '../../strings';
import { pick } from '../Overlays';
import { toast } from '../Toast';
import { recordVoice } from '../VoiceRecorder';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TYPING_REPEAT_MS = 10000;
const TYPING_IDLE_MS = 5000;
const DRAFT_SAVE_MS = 800;
const PREVIEW_DEBOUNCE_MS = 1000;

/** After picking a photo or video, whether it goes view-once; other files never do. Undefined when cancelled. */
export async function askViewOnce(type: string): Promise<boolean | undefined> {
  const media = type.indexOf('image/') === 0 ? S.photo : type.indexOf('video/') === 0 ? S.video : '';
  if (!media) return false;
  const choice = await pick(
    media,
    [
      { value: 'attach', label: S.attachNormal, sub: S.attachNormalSub },
      { value: 'viewOnce', label: S.sendViewOnce, sub: S.sendViewOnceSub },
    ],
    'attach'
  );
  return choice === undefined ? undefined : choice === 'viewOnce';
}

/** The composer of an open chat: its draft (saved as the chat's draft), reply or edit context, attachment tray, link preview, typing indicators, and sending. */
export function useChatComposer(convId: string, conv: Conversation | undefined, canCompose: boolean, setFocusedId: (id: string | null) => void) {
  const convRef = useRef(conv);
  convRef.current = conv;
  const [draft, setDraft] = useState(() => (conv && conv.draft) || '');
  const [quote, setQuote] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [tray, setTray] = useState<store.OutgoingFile[]>([]);
  const mentionsRef = useRef<PickedMention[]>((conv && conv.draftMentions) || []);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const typingRef = useRef<{ last: number; idle: ReturnType<typeof setTimeout> | null }>({ last: 0, idle: null });

  const [linkPreview, setLinkPreview] = useState<FetchedPreview | null>(null);
  const dismissedPreview = useRef('');
  const previewUrl = previewCandidate(draft, { enabled: config.linkPreviews(), plainText: canCompose && !editing && !tray.length });
  const shownPreview = linkPreview && linkPreview.url === previewUrl ? linkPreview : null;
  useEffect(() => {
    if (!previewUrl || previewUrl === dismissedPreview.current) return;
    let live = true;
    const t = setTimeout(() => {
      fetchLinkPreview(previewUrl).then((p) => live && setLinkPreview(p), () => {});
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [previewUrl]);

  function saveDraft(): void {
    if (!editingRef.current) store.setDraft(convId, draftRef.current, mentionsRef.current);
  }

  useEffect(() => {
    if (editing) return;
    const t = setTimeout(saveDraft, DRAFT_SAVE_MS);
    return () => clearTimeout(t);
  }, [draft, editing]);

  function stopTyping(): void {
    const t = typingRef.current;
    if (t.idle) clearTimeout(t.idle);
    t.idle = null;
    const c = convRef.current;
    if (t.last && c && c.sendId) signal.sendTyping(c.sendId, false).catch(() => {});
    t.last = 0;
  }

  function onDraft(v: string): void {
    setDraft(v);
    const c = convRef.current;
    if (!config.typingIndicators() || !c || !c.sendId || editing) return;
    const t = typingRef.current;
    if (!v.trim()) return stopTyping();
    const now = Date.now();
    if (now - t.last > TYPING_REPEAT_MS) {
      t.last = now;
      signal.sendTyping(c.sendId, true).catch(() => {});
    }
    if (t.idle) clearTimeout(t.idle);
    t.idle = setTimeout(stopTyping, TYPING_IDLE_MS);
  }

  function insertText(text: string): void {
    const el = inputRef.current;
    const start = el && el.selectionStart != null ? el.selectionStart : draft.length;
    const end = el && el.selectionEnd != null ? el.selectionEnd : start;
    const next = draft.slice(0, start) + text + draft.slice(end);
    onDraft(next);
    setFocusedId(null);
    requestAnimationFrame(() => {
      const e = inputRef.current;
      if (!e) return;
      try {
        e.setSelectionRange(start + text.length, start + text.length);
      } catch {
        // not all inputs keep a selection
      }
    });
  }

  function clearComposer(): void {
    setDraft('');
    mentionsRef.current = [];
  }

  /** Back to the chat's own draft after editing a sent message. */
  function restoreDraft(): void {
    const c = convRef.current;
    setDraft((c && c.draft) || '');
    mentionsRef.current = (c && c.draftMentions) || [];
  }

  function clearContext(): void {
    if (editing) restoreDraft();
    setQuote(null);
    setEditing(null);
  }

  function startReply(m: Message): void {
    if (editing) restoreDraft();
    setEditing(null);
    setQuote(m);
    setFocusedId(null);
  }

  function startEdit(m: Message): void {
    saveDraft();
    setQuote(null);
    setEditing(m);
    setDraft(m.raw != null ? m.raw : m.body);
    mentionsRef.current = m.mentions || [];
    setFocusedId(null);
  }

  function dismissPreview(): void {
    if (!shownPreview) return;
    dismissedPreview.current = shownPreview.url;
    setLinkPreview(null);
  }

  function submit(): void {
    const text = draft.trim();
    if ((!text && !tray.length) || !canCompose) return;
    stopTyping();
    const mentions = mentionsRef.current;
    if (editing) {
      const target = editing;
      setEditing(null);
      restoreDraft();
      store.sendEdit(target, text, mentions).catch((e) => toast(sendError(e)));
      return;
    }
    const q: Quote | null = quote
      ? {
          author: quote.incoming ? quote.author : store.selfNumber(),
          timestamp: quote.timestamp,
          text: quote.body,
          attachments: quote.attachments.length ? quote.attachments.map((a) => ({ contentType: a.contentType, filename: a.filename })) : undefined,
        }
      : null;
    clearComposer();
    setQuote(null);
    store.setDraft(convId, '', []);
    if (tray.length) {
      const files = tray;
      setTray([]);
      store.sendAttachments(convId, files, text, { quote: q }).catch((e) => toast(sendError(e)));
      return;
    }
    const preview = shownPreview;
    setLinkPreview(null);
    dismissedPreview.current = '';
    store.sendText(convId, text, q, mentions, preview).catch((e) => toast(sendError(e)));
  }

  /** Photos, videos, and files wait above the message box until Send; view-once media and voice messages go alone right away. A photo or video asks whether it goes view-once, which is sent without a caption, so the draft stays in the composer. */
  async function attach(): Promise<void> {
    const file = await chooseFile();
    if (!file) return;
    const type = file.type || 'application/octet-stream';
    if (file.size > MAX_FILE_BYTES) return toast(S.fileTooLarge);
    const viewOnce = await askViewOnce(type);
    if (viewOnce === undefined) return;
    const alone = viewOnce || type.indexOf('audio/') === 0;
    if (!alone && tray.length >= store.MAX_ATTACHMENTS) return toast(fmt(S.tooManyAttachments, { n: store.MAX_ATTACHMENTS }));
    if (!alone && tray.reduce((sum, f) => sum + (f.size || 0), 0) + file.size > MAX_FILE_BYTES) return toast(S.attachmentsTooLarge);
    toast(S.preparingFile);
    try {
      const out: store.OutgoingFile = { dataUri: await readDataUri(file, file.name), contentType: type, filename: file.name, size: file.size };
      if (type.indexOf('image/') === 0) Object.assign(out, await photoBlurHash(file));
      if (!alone) {
        setTray((cur) => cur.concat(out));
        setFocusedId(null);
        return;
      }
      const caption = viewOnce ? '' : draft.trim();
      if (!viewOnce) {
        clearComposer();
        store.setDraft(convId, '', []);
      }
      await store.sendAttachments(convId, [out], caption, { viewOnce });
    } catch (e) {
      toast(sendError(e));
    }
  }

  /** A voice message goes alone, without the draft, as in Signal. */
  async function voiceMessage(): Promise<void> {
    const note = await recordVoice();
    if (!note) return;
    try {
      await store.sendAttachments(convId, [await voiceNoteFile(note)], '');
    } catch (e) {
      toast(sendError(e));
    }
  }

  async function mention(): Promise<void> {
    if (!conv || !conv.sendId) return toast(S.groupNotReady);
    const detail = await groupDetail(conv.sendId);
    const me = store.selfNumber();
    const options = (detail.members || []).filter((id) => id !== me && id !== config.aci()).map((id) => ({ value: id, label: store.displayName(id) }));
    if (!options.length) return toast(S.groupNotReady);
    const id = await pick(S.mention, options, '');
    if (!id) return;
    const name = store.displayName(id);
    mentionsRef.current = mentionsRef.current.filter((p) => p.uuid !== id).concat({ name, uuid: id });
    insertText('@' + name + ' ');
  }

  function leave(): void {
    stopTyping();
    saveDraft();
  }

  return {
    draft,
    quote,
    editing,
    tray,
    setTray,
    inputRef,
    shownPreview,
    dismissPreview,
    onDraft,
    insertText,
    clearContext,
    startReply,
    startEdit,
    submit,
    attach,
    voiceMessage,
    mention,
    leave,
  };
}

import { useRefresh } from '../../app/hooks';
import { pick } from '../../components/Overlays';
import { Row, RowList } from '../../components/RowList';
import { Screen } from '../../components/Screen';
import { toggleRow } from '../../components/setting-rows';
import { toast } from '../../components/Toast';
import { signal } from '../../data/api';
import { config, type NotifyShow } from '../../data/config';
import { fmtMsgTime } from '../../data/format';
import * as store from '../../data/store';
import { friendlyError } from '../../errors';
import { S } from '../../strings';
import { guideRow } from '../Guide';

const SHOW_LABELS: Record<NotifyShow, string> = { all: S.showNameAndMessage, name: S.showNameOnly, none: S.showNothing };

type SyncedDefault = 'reactions' | 'mentionsIfMuted' | 'repliesIfMuted' | 'callsIfMuted';
const CONFIG_KEY = { reactions: 'notifyReactions', mentionsIfMuted: 'notifyMentionsIfMuted', repliesIfMuted: 'notifyRepliesIfMuted', callsIfMuted: 'notifyCallsIfMuted' } as const;

const HOUR = 3600000;

function profileName(p: store.NotificationProfile): string {
  return (p.emoji ? p.emoji + ' ' : '') + p.name;
}

/** "Off", "🌙 Sleep", or "💼 Work until 15:00" when it was switched on for a while. */
function profileLabel(): string {
  const p = store.activeProfile();
  if (!p) return S.off;
  const o = config.notificationProfileOverride();
  const until = o && 'enabledId' in o && o.enabledId === p.id ? o.endAt : 0;
  return until ? S.profileUntil.replace('{name}', profileName(p)).replace('{time}', fmtMsgTime(until)) : profileName(p);
}

/** What notifications show, whether they make a sound, and what still notifies in muted chats; all but Show and Sound are shared with the account's other devices. */
export function NotificationsScreen() {
  const refresh = useRefresh();

  function setDefault(key: SyncedDefault, on: boolean): void {
    config.set({ [CONFIG_KEY[key]]: on });
    refresh();
    signal.setNotificationDefaults({ [key]: on }).catch((e) => toast(friendlyError(e)));
  }

  async function chooseShow(): Promise<void> {
    const options = (Object.keys(SHOW_LABELS) as NotifyShow[]).map((v) => ({ value: v, label: SHOW_LABELS[v] }));
    const v = await pick(S.notifyShow, options, config.notifyShow());
    if (!v) return;
    config.set({ notifyShow: v });
    refresh();
  }

  async function chooseProfile(): Promise<void> {
    const active = store.activeProfile();
    const options: Array<{ value: string; label: string }> = [{ value: '', label: S.off }];
    for (const p of config.notificationProfiles()) options.push({ value: p.id, label: profileName(p) });
    const id = await pick(S.notificationProfile, options, active ? active.id : '');
    if (id === undefined) return;
    if (!id) {
      if (active) store.setProfileOverride(null);
      return refresh();
    }
    const ms = await pick(S.notificationProfile, [{ value: HOUR, label: S.forOneHour }, { value: 0, label: S.untilTurnedOff }], 0);
    if (ms === undefined) return;
    store.setProfileOverride(id, ms ? Date.now() + ms : 0);
    refresh();
  }

  const hasProfiles = config.notificationProfiles().length > 0;
  const rows: Row[] = [
    { key: 'profile', label: S.notificationProfile, sub: hasProfiles ? profileLabel() : S.noProfiles, onSelect: hasProfiles ? chooseProfile : undefined },
    { key: 'show', label: S.notifyShow, sub: SHOW_LABELS[config.notifyShow()] + ' · ' + S.notifyShowHint, onSelect: chooseShow },
    toggleRow('sound', S.notifySound, config.notifySound(), (v) => (config.set({ notifySound: v }), refresh())),
    toggleRow('reactions', S.reactionNotifications, config.notifyReactions(), (v) => setDefault('reactions', v)),
    { section: S.inMutedChats },
    toggleRow('mentions', S.notifyForMentions, config.notifyMentionsIfMuted(), (v) => setDefault('mentionsIfMuted', v)),
    toggleRow('replies', S.notifyForReplies, config.notifyRepliesIfMuted(), (v) => setDefault('repliesIfMuted', v)),
    toggleRow('calls', S.notifyForCalls, config.notifyCallsIfMuted(), (v) => setDefault('callsIfMuted', v)),
    { section: '' },
    guideRow('notifications'),
  ];
  return (
    <Screen title={S.notifications}>
      <RowList rows={rows} />
    </Screen>
  );
}

import { useEffect, useState } from 'preact/hooks';
import { Row, RowList } from '../../components/RowList';
import { Screen } from '../../components/Screen';
import { GUIDES, GuideTopic } from '../../data/guides';
import { appVersion } from '../../data/platform';
import { APP_NAME, S } from '../../strings';
import { openGuide } from '../Guide';

export const HELP_TOPICS: GuideTopic[] = ['setup', 'history', 'keys', 'chats', 'folders', 'groups', 'settings', 'proxy', 'notifications', 'limitations', 'troubleshooting'];

/** Short pointers into the full guide; each topic shows a QR code and can open in the browser. */
export function HelpScreen() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    appVersion().then(setVersion);
  }, []);
  const topic = (t: GuideTopic): Row => ({ key: t, label: GUIDES[t].title, icon: GUIDES[t].icon, end: 'chevron', onSelect: () => openGuide(t) });
  return (
    <Screen title={S.help}>
      <RowList
        rows={[
          ...HELP_TOPICS.map(topic),
          { section: APP_NAME },
          topic('source'),
          { key: 'about', label: S.version + ' ' + (version || '…'), sub: S.unofficial },
        ]}
      />
    </Screen>
  );
}

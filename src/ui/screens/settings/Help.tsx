import { useEffect, useState } from 'preact/hooks';
import { RowList } from '../../components/RowList';
import { Screen } from '../../components/Screen';
import { toast } from '../../components/Toast';
import { appVersion, openUrl } from '../../data/platform';
import { APP_NAME, S } from '../../strings';

export const GUIDE_URL = 'https://github.com/ambercaravalho/signal4kaios/blob/main/docs/user-guide.md';
export const SOURCE_URL = 'https://github.com/ambercaravalho/signal4kaios';

export function HelpScreen() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    appVersion().then(setVersion);
  }, []);
  const open = (url: string) => () => openUrl(url).catch(() => toast(S.errGeneric));
  return (
    <Screen title={S.help}>
      <RowList
        rows={[
          { key: 'ver', label: APP_NAME, sub: S.version + ' ' + (version || '…') },
          { key: 'guide', label: S.userGuide, onSelect: open(GUIDE_URL) },
          { key: 'src', label: S.sourceCode, onSelect: open(SOURCE_URL) },
          { key: 'about', label: S.unofficialTitle, sub: S.unofficial },
        ]}
      />
    </Screen>
  );
}

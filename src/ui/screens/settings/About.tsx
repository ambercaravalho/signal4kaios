import { useEffect, useState } from 'preact/hooks';
import { useRefresh, useStoreEvents } from '../../app/hooks';
import { RowList } from '../../components/RowList';
import { Screen } from '../../components/Screen';
import { GUIDES } from '../../data/guides';
import { appVersion } from '../../data/platform';
import { S } from '../../strings';
import { openGuide } from '../Guide';
import { autoUpdateRow, updateRow } from './Updates';

/** The installed version, updates, and the source code. */
export function AboutScreen() {
  useStoreEvents(['update']);
  const refresh = useRefresh();
  const [version, setVersion] = useState('');
  useEffect(() => {
    appVersion().then(setVersion);
  }, []);
  return (
    <Screen title={S.aboutApp}>
      <RowList
        rows={[
          { key: 'version', label: S.version + ' ' + (version || '…'), sub: S.unofficial },
          updateRow(),
          autoUpdateRow(refresh),
          { key: 'source', label: GUIDES.source.title, icon: GUIDES.source.icon, end: 'chevron', onSelect: () => openGuide('source') },
        ]}
      />
    </Screen>
  );
}

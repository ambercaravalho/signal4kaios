import { router, useKeys, useSoftkeys } from '../app/router';
import { Pictogram } from '../components/Pictogram';
import { QrCode } from '../components/Qr';
import type { ActionRow } from '../components/RowList';
import { Screen } from '../components/Screen';
import { toast } from '../components/Toast';
import { GUIDES, GuideTopic } from '../data/guides';
import { openUrl } from '../data/platform';
import { S } from '../strings';

/** One topic of the full guide: a QR code to read it on another device, or Open for the phone's browser. */
export function GuideScreen(props: { topic: GuideTopic }) {
  const guide = GUIDES[props.topic];
  useSoftkeys({ center: S.open, right: null });
  useKeys((e) => {
    if (e.key !== 'Enter') return false;
    openUrl(guide.url).catch(() => toast(S.errGeneric));
    return true;
  });
  return (
    <Screen title={guide.title} bodyClass="guide">
      <div class="guide-head">
        <Pictogram name={guide.pictogram} class="guide-pictogram" />
        <div class="guide-line">{S.guideScan}</div>
      </div>
      {/* Low error correction keeps long guide links to fewer, larger modules on the small screen. */}
      <QrCode text={guide.url} ecc="low" />
    </Screen>
  );
}

export function openGuide(topic: GuideTopic): void {
  router.push(GuideScreen, { topic });
}

/** A row that opens a guide topic, labelled "Learn more" unless given a label. */
export function guideRow(topic: GuideTopic, label: string = S.learnMore): ActionRow {
  return { key: 'guide-' + topic, label, icon: 'help', end: 'chevron', onSelect: () => openGuide(topic) };
}

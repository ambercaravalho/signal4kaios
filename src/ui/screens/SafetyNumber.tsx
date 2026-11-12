import { useEffect, useRef, useState } from 'preact/hooks';
import { router, useKeys, useSoftkeys } from '../app/router';
import { Icon } from '../components/Icon';
import { EmptyState, Spinner } from '../components/List';
import { alertDialog, showOptions } from '../components/Overlays';
import { scanQr } from '../components/Qr';
import { Screen } from '../components/Screen';
import { toast } from '../components/Toast';
import { signal } from '../data/api';
import { formatSafetyNumber } from '../data/format';
import { contactByKey } from '../data/store';
import { friendlyError } from '../errors';
import { fmt, S } from '../strings';
import { openGuide } from './Guide';
import { QrScreen } from './QrScreen';

type Identity = Awaited<ReturnType<typeof signal.identities>>[number];

/** Compare a contact's safety number, show or scan the code, and mark them verified. */
export function SafetyNumberScreen(props: { target: string; name: string }) {
  const [entry, setEntry] = useState<Identity | null | undefined>(undefined);
  const body = useRef<HTMLDivElement>(null);

  const load = () => {
    const c = contactByKey(props.target);
    const ids = [props.target, c && c.uuid, c && c.number].filter(Boolean);
    signal.identities().then(
      (all) => setEntry(all.find((e) => ids.indexOf(e.uuid || '') >= 0 || ids.indexOf(e.number || '') >= 0) || null),
      (e) => {
        toast(friendlyError(e));
        setEntry(null);
      }
    );
  };
  useEffect(load, [props.target]);

  const verified = !!entry && entry.trust_level === 'TRUSTED_VERIFIED';

  function setVerified(on: boolean): void {
    if (!entry) return;
    const target = entry.uuid || entry.number || props.target;
    signal.trustIdentity(target, on ? { verified_safety_number: entry.safety_number, trust_all_known_keys: true } : undefined).then(
      () => {
        toast(on ? S.markedVerified : S.verificationCleared);
        load();
      },
      (e) => toast(friendlyError(e))
    );
  }

  async function scan(): Promise<void> {
    if (!entry) return;
    const text = await scanQr(S.scanCode);
    if (!text) return;
    if (signal.verifySafetyNumberQr(text, entry.scannable_safety_number, entry.safety_number)) {
      await alertDialog(S.safetyNumber, S.scanMatch);
      setVerified(true);
    } else alertDialog(S.safetyNumber, S.scanMismatch);
  }

  useSoftkeys({ center: entry ? (verified ? S.clearVerified : S.markVerified) : null, right: entry ? S.options : null });
  useKeys((e) => {
    if (!entry) return false;
    if (e.key === 'Enter') setVerified(!verified);
    else if (e.key === 'SoftRight')
      showOptions([
        !!entry.scannable_safety_number && { label: S.showCode, onSelect: () => router.push(QrScreen, { title: S.safetyNumber, text: entry.scannable_safety_number, caption: fmt(S.showCodeHint, { name: props.name }) }) },
        !!entry.scannable_safety_number && { label: S.scanCode, onSelect: scan },
        { label: S.learnMore, onSelect: () => openGuide('groups') },
      ]);
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && body.current) body.current.scrollTop += e.key === 'ArrowDown' ? 40 : -40;
    else return false;
    return true;
  });

  let content;
  if (entry === undefined) content = <Spinner />;
  else if (!entry) content = <EmptyState title={S.safetyNumber} body={S.noSafetyNumber} pictogram="safety" />;
  else
    content = (
      <>
        {verified && (
          <div class="safety-verified">
            <Icon name="verified" /> {S.verified}
          </div>
        )}
        <div class="safety-grid">
          {formatSafetyNumber(entry.safety_number).map((g, i) => (
            <span key={i}>{g}</span>
          ))}
        </div>
        <div class="safety-hint">{fmt(S.safetyNumberHint, { name: props.name })}</div>
      </>
    );

  return (
    <Screen title={S.safetyNumber}>
      <div class="safety" ref={body}>
        {content}
      </div>
    </Screen>
  );
}

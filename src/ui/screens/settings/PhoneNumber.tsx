import { useRefresh } from '../../app/hooks';
import { pick } from '../../components/Overlays';
import { Row, RowList } from '../../components/RowList';
import { Screen } from '../../components/Screen';
import { toast } from '../../components/Toast';
import { signal } from '../../data/api';
import { config } from '../../data/config';
import { friendlyError } from '../../errors';
import { S } from '../../strings';

/** Who sees and who can find you by your number, as in Signal: a number everybody sees can always be found. */
export function PhoneNumberScreen() {
  const refresh = useRefresh();
  const share = config.sharePhoneNumber();
  const findable = config.findableByNumber();
  const label = (on: boolean) => (on ? S.everybody : S.nobody);

  function save(nextShare: boolean, nextFindable: boolean): void {
    config.set({ sharePhoneNumber: nextShare, findableByNumber: nextShare || nextFindable });
    refresh();
    signal.setPhoneNumberPrivacy(nextShare, nextFindable).catch((e) => {
      config.set({ sharePhoneNumber: share, findableByNumber: findable });
      refresh();
      toast(friendlyError(e));
    });
  }

  async function choose(title: string, nobodyHint: string, current: boolean, apply: (v: boolean) => void): Promise<void> {
    const v = await pick(title, [{ value: true, label: S.everybody }, { value: false, label: S.nobody, sub: nobodyHint }], current);
    if (v !== undefined && v !== current) apply(v);
  }

  const rows: Row[] = [
    { key: 'see', label: S.whoCanSeeNumber, sub: label(share), onSelect: () => choose(S.whoCanSeeNumber, S.seeNumberHint, share, (v) => save(v, v || findable)) },
    {
      key: 'find',
      label: S.whoCanFindNumber,
      sub: label(findable),
      onSelect: () => (share ? toast(S.findLocked) : choose(S.whoCanFindNumber, S.findNumberHint, findable, (v) => save(false, v))),
    },
  ];
  return (
    <Screen title={S.phoneNumber}>
      <RowList rows={rows} />
    </Screen>
  );
}

import { useRefresh } from '../../app/hooks';
import { setTextSize, setTheme } from '../../app/theme';
import { pick } from '../../components/Overlays';
import { RowList } from '../../components/RowList';
import { Screen } from '../../components/Screen';
import { config, type TextSize, type ThemeName } from '../../data/config';
import { S } from '../../strings';

export function AppearanceScreen() {
  const refresh = useRefresh();
  const theme = config.theme();
  async function choose(): Promise<void> {
    const t = await pick<ThemeName>(S.theme, [{ value: 'light', label: S.light }, { value: 'dark', label: S.dark }], theme);
    if (t) {
      setTheme(t);
      refresh();
    }
  }
  const size = config.textSize();
  const sizes: Array<{ value: TextSize; label: string }> = [
    { value: 'small', label: S.textSmall },
    { value: 'normal', label: S.textNormal },
    { value: 'large', label: S.textLarge },
    { value: 'xlarge', label: S.textExtraLarge },
  ];
  async function chooseSize(): Promise<void> {
    const v = await pick<TextSize>(S.textSize, sizes, size);
    if (v) {
      setTextSize(v);
      refresh();
    }
  }
  return (
    <Screen title={S.appearance}>
      <RowList
        rows={[
          { key: 'theme', label: S.theme, sub: theme === 'dark' ? S.dark : S.light, onSelect: choose },
          { key: 'text', label: S.textSize, sub: sizes.filter((s) => s.value === size)[0].label, onSelect: chooseSize },
        ]}
      />
    </Screen>
  );
}

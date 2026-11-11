import { config, type TextSize, type ThemeName } from '../data/config';

/** The status bar matches each theme's header. */
const STATUS_BAR: Record<ThemeName, string> = { light: '#2c6bed', dark: '#1e1e1e' };

/** The root font size for each text size; every length in the theme is in rem, so the whole layout scales with it. */
export const TEXT_SIZE_PX: Record<TextSize, number> = { small: 9, normal: 10, large: 11, xlarge: 12 };

export function applyTheme(): void {
  const t = config.theme();
  document.documentElement.setAttribute('data-theme', t);
  document.documentElement.style.fontSize = TEXT_SIZE_PX[config.textSize()] + 'px';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', STATUS_BAR[t]);
}

export function setTheme(t: ThemeName): void {
  config.set({ theme: t });
  applyTheme();
}

export function setTextSize(size: TextSize): void {
  config.set({ textSize: size });
  applyTheme();
}

import { config, type ThemeName } from '../data/config';

/** The status bar matches each theme's header. */
const STATUS_BAR: Record<ThemeName, string> = { light: '#2c6bed', dark: '#1e1e1e' };

export function applyTheme(): void {
  const t = config.theme();
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', STATUS_BAR[t]);
}

export function setTheme(t: ThemeName): void {
  config.set({ theme: t });
  applyTheme();
}

/* The full guides on GitHub that the app's short help points to. Every `#anchor` must match a heading in `docs/`; `test/ui-guides.test.ts` checks them. */

import { S } from '../strings';

export const SOURCE_URL = 'https://github.com/ambercaravalho/signal4kaios';
const DOCS = SOURCE_URL + '/blob/main/docs/';
export const SETUP_URL = DOCS + 'setup.md';
export const GUIDE_URL = DOCS + 'user-guide.md';

export interface Guide {
  title: string;
  url: string;
  icon: string;
  pictogram: string;
}

export const GUIDES = {
  setup: { title: S.guideSetup, url: SETUP_URL, icon: 'phone', pictogram: 'welcome' },
  linking: { title: S.guideLinking, url: SETUP_URL + '#2-link-your-signal-account', icon: 'lock', pictogram: 'link' },
  keys: { title: S.guideKeys, url: GUIDE_URL + '#keys', icon: 'note', pictogram: 'keys' },
  chats: { title: S.guideChats, url: GUIDE_URL + '#inside-a-chat', icon: 'chat', pictogram: 'chats' },
  folders: { title: S.guideFolders, url: GUIDE_URL + '#chat-folders', icon: 'archive', pictogram: 'chats' },
  history: { title: S.guideHistory, url: SETUP_URL + '#message-history', icon: 'clock', pictogram: 'link' },
  groups: { title: S.guideGroups, url: GUIDE_URL + '#chat-settings-groups-and-safety-numbers', icon: 'group', pictogram: 'safety' },
  settings: { title: S.guideSettings, url: GUIDE_URL + '#settings', icon: 'gear', pictogram: 'settings' },
  proxy: { title: S.guideProxy, url: GUIDE_URL + '#proxy', icon: 'verified', pictogram: 'proxy' },
  notifications: { title: S.guideNotifications, url: GUIDE_URL + '#notifications', icon: 'bell', pictogram: 'bell' },
  limitations: { title: S.guideLimitations, url: GUIDE_URL + '#known-limitations', icon: 'alert', pictogram: 'limits' },
  troubleshooting: { title: S.guideTroubleshooting, url: SETUP_URL + '#troubleshooting', icon: 'help', pictogram: 'trouble' },
  source: { title: S.sourceCode, url: SOURCE_URL, icon: 'file', pictogram: 'code' },
} satisfies Record<string, Guide>;

export type GuideTopic = keyof typeof GUIDES;

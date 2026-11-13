import { render } from 'preact';
import { router, RouterView } from './app/router';
import { applyTheme } from './app/theme';
import { SoftkeyBar } from './components/Screen';
import { toast, ToastHost } from './components/Toast';
import { signal } from './data/api';
import { inCall } from './data/calls';
import { config } from './data/config';
import { db, PRUNE_KEEP } from './data/db';
import { installEngineHost, onNumberChange } from './data/engine-host';
import * as http from './data/http';
import { dbg } from './data/log';
import { hasServiceWorker } from './data/platform';
import { applyProxy } from './data/proxy';
import * as screenLock from './data/screen-lock';
import * as store from './data/store';
import { setupWake, WAKE_CACHE } from './data/wake';
import { reloadUnderServiceWorker } from './data/wasm-reload';
import * as ws from './data/ws';
import { fmt, S } from './strings';
import { installCallScreen } from './screens/Call';
import { openChat } from './screens/Chat';
import { HistoryScreen } from './screens/History';
import { HomeScreen } from './screens/Home';
import { LockGate } from './screens/Lock';
import { LinkScreen, WelcomeScreen } from './screens/Onboarding';
import { StartupErrorScreen } from './screens/StartupError';
import './theme/index.css';

const PENDING_CONV_KEY = '/__s4k_pending_conv';
const PENDING_MAX_AGE_MS = 60000;

function openConversation(convId: string | null | undefined): void {
  // A chat opened over the call screen would hide the call with no way back to it.
  if (inCall()) return;
  if (!convId || store.openConversationId() === convId || !store.conversation(convId)) return;
  openChat(convId);
}

/** A notification tapped while the app was closed can't message a live window, so the ServiceWorker leaves the chat in Cache Storage. Only a fresh entry counts, so a later unrelated launch still lands on the chat list. */
function openPendingConversation(): void {
  if (typeof caches === 'undefined') return;
  caches
    .open(WAKE_CACHE)
    .then((cache) =>
      cache.match(PENDING_CONV_KEY).then((res) => {
        if (!res) return null;
        return res.json().then((info) => cache.delete(PENDING_CONV_KEY).then(() => info));
      })
    )
    .then((info) => {
      if (!info || typeof info.convId !== 'string') return;
      if (typeof info.ts === 'number' && Date.now() - info.ts > PENDING_MAX_AGE_MS) return;
      openConversation(info.convId);
    })
    .catch((e) => dbg('boot: pending chat read failed ' + (e && e.message)));
}

function registerServiceWorker(): void {
  if (!hasServiceWorker()) return;
  try {
    navigator.serviceWorker.register('/sw.js').then(
      () => dbg('sw: registered'),
      (e) => dbg('sw: registration failed ' + (e && e.message))
    );
    navigator.serviceWorker.addEventListener('message', (evt) => {
      const data = evt && evt.data;
      if (data && data.type === 's4k-open-conversation' && typeof data.convId === 'string') {
        try {
          window.focus();
        } catch {
          // not focusable
        }
        openConversation(data.convId);
      }
    });
  } catch (e: any) {
    dbg('sw: unavailable ' + (e && e.message));
  }
}

function onUnlinked(): void {
  dbg('auth: this device was unlinked');
  ws.stop();
  config.forgetAccount();
  location.reload();
}

function start(): void {
  http.onUnlinked(onUnlinked);
  ws.onUnlinked(onUnlinked);
  store.on('storage-error', () => toast(S.storageError, 4000));
  onNumberChange((number) => toast(fmt(S.numberChanged, { number }), 5000));

  // Message history from linking is imported before the first connection, so nothing new lands in the middle of it.
  if (config.isConfigured() && config.historySync()) {
    router.reset(HistoryScreen, {});
    return;
  }
  if (config.isConfigured()) router.reset(HomeScreen, {});
  else if (config.number() || config.aci()) router.reset(LinkScreen, { mode: 'relink' as const });
  else router.reset(WelcomeScreen, {});

  if (!config.isConfigured()) {
    setupWake();
    return;
  }
  store.onNotificationClick(openConversation);
  store.init().then(() => {
    installCallScreen();
    ws.connect();
    ws.installWakeHandlers();
    openPendingConversation();
    setTimeout(() => {
      for (const c of store.conversations().concat(store.archivedConversations())) db.pruneConversation(c.id, PRUNE_KEEP).catch(() => {});
    }, 5000);
  });
  setupWake();
}

function boot(): void {
  dbg('boot');
  applyTheme();
  applyProxy();
  installEngineHost();
  registerServiceWorker();
  screenLock.install();
  render(
    <>
      <RouterView />
      <SoftkeyBar />
      <ToastHost />
      <LockGate />
    </>,
    document.getElementById('app')!
  );

  // Every Signal operation runs in the libsignal WebAssembly module, so nothing may touch `signal` until it has loaded.
  signal.ready().then(
    (version) => {
      dbg('libsignal ' + version + ' ready');
      db.ready().then(
        () => {
          // A pre-libsignal database was upgraded and its protocol state discarded, so the old link can't be used.
          if (db.signalStateWasReset() && config.isConfigured()) {
            dbg('boot: protocol state was reset, relink required');
            config.forgetAccount();
          }
          start();
        },
        (e) => {
          dbg('boot: database open failed ' + (e && e.message));
          router.reset(StartupErrorScreen, { reason: 'storage', detail: String((e && e.message) || e) });
        }
      );
    },
    (err) => {
      dbg('libsignal failed to load: ' + ((err && err.reason) || '') + ' ' + (err && err.message));
      const showError = () => router.reset(StartupErrorScreen, { reason: (err && err.reason) || 'fetch', detail: String((err && err.message) || err) });
      if (err && err.reason === 'blocked') reloadUnderServiceWorker().then((reloading) => reloading || showError());
      else showError();
    }
  );
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

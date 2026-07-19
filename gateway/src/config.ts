/* Gateway configuration, read once from the environment. */

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = parseInt(raw, 10);
  return isNaN(n) ? def : n;
}

function boolEnv(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  return /^(1|true|yes|on)$/i.test(raw);
}

const signalCliUrl = (process.env.SIGNAL_CLI_URL || 'http://127.0.0.1:8080')
  .replace(/\/+$/, '');

export const config = {
  port: intEnv('PORT', 8090),
  signalCliUrl: signalCliUrl,
  // ws:// (or wss://) form of the same server, for the upstream receive socket.
  signalCliWsUrl: signalCliUrl.replace(/^http/, 'ws'),
  dbPath: process.env.DB_PATH || './data/gateway.db',
  retentionPerNumber: intEnv('RETENTION_PER_NUMBER', 500),
  pushWhenIdleOnly: boolEnv('PUSH_WHEN_IDLE_ONLY', true),
  vapidPublic: process.env.VAPID_PUBLIC || '',
  vapidPrivate: process.env.VAPID_PRIVATE || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com'
};

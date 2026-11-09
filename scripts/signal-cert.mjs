#!/usr/bin/env node
// Makes a rooted KaiOS phone's Gecko trust Signal's root certificate, so Beacon can fetch photos and files over the phone's built-in TLS.
//
// The certificate is added by the phone's own Gecko (nsIX509CertDB in the b2g main process, over the adb-forwarded debugger socket), not by a desktop certutil: a newer desktop NSS writes trust records that the phone's older NSS drops at the next start.
//
// Prerequisites: adb on your PATH, a rooted phone with "ADB and DevTools" enabled, Node.js 22+.
//
// Usage:
//   node scripts/signal-cert.mjs install         back up the certificate database, then add and trust Signal's root
//   node scripts/signal-cert.mjs status          report whether Signal's root is present and trusted
//   node scripts/signal-cert.mjs remove          back up the certificate database, then delete Signal's root
//   node scripts/signal-cert.mjs restore <dir>   put a backup from dist/cert-backups/ back (restarts the phone's UI)
//
// Then open Beacon and check Settings -> Debug -> Faster connection.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CERT = join(ROOT, 'src/native/libsignal-wasm/res/signal.cer');
const PORT = Number(process.env.PORT || 6000);
const DB_FILES = ['cert9.db', 'key4.db', 'pkcs11.txt'];

function fail(msg) {
  console.error('FAIL: ' + msg);
  process.exit(1);
}

function adb(args, { allowFail = false } = {}) {
  const r = spawnSync('adb', args, { encoding: 'utf8' });
  if (r.error) fail('adb not found on PATH.');
  if (r.status !== 0 && !allowFail) fail('adb ' + args.join(' ') + ': ' + (r.stderr || r.stdout).trim());
  return (r.stdout || '').trim();
}

const shell = (cmd, opts) => adb(['shell', cmd], opts);

function profileDir() {
  const dir = shell('ls -d /data/b2g/mozilla/*.default 2>/dev/null', { allowFail: true }).split('\n')[0].trim();
  if (!dir) fail('no Gecko profile under /data/b2g/mozilla. Is the phone rooted, and did `adb root` work?');
  return dir;
}

function backup(profile) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(ROOT, 'dist/cert-backups', stamp);
  mkdirSync(dir, { recursive: true });
  for (const f of DB_FILES) adb(['pull', '-q', profile + '/' + f, join(dir, f)]);
  console.log('Backed up the certificate database to ' + dir);
}

function restore(profile, dir) {
  if (!dir || !DB_FILES.every((f) => existsSync(join(dir, f)))) fail('restore needs a backup folder containing ' + DB_FILES.join(', '));
  shell('stop b2g');
  for (const f of DB_FILES) adb(['push', '-q', join(dir, f), profile + '/' + f]);
  shell(`chmod 600 ${DB_FILES.map((f) => profile + '/' + f).join(' ')}`);
  shell('start b2g');
  console.log('OK: restored ' + dir + '. The phone UI is restarting.');
}

function forwardDebugger() {
  const socket = shell('test -S /data/local/firefox-debugger-socket && echo /data/local/firefox-debugger-socket || echo /data/local/debugger-socket');
  adb(['forward', 'tcp:' + PORT, 'localfilesystem:' + socket]);
}

/** Evaluates `text` in the b2g main process over the Firefox Remote Debugging Protocol and resolves to the result. */
function evalInParent(text) {
  return new Promise((resolvePromise, reject) => {
    const sock = net.connect(PORT, '127.0.0.1');
    let buf = Buffer.alloc(0);
    const waiters = [];
    const timer = setTimeout(() => reject(new Error('the debugger did not answer. Enable "ADB and DevTools" on the phone.')), 30000);
    sock.on('error', (e) => reject(new Error('cannot reach the debugger socket (' + e.message + ').')));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const colon = buf.indexOf(58);
        if (colon < 0) return;
        const len = parseInt(buf.subarray(0, colon).toString(), 10);
        if (buf.length < colon + 1 + len) return;
        const pkt = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString());
        buf = buf.subarray(colon + 1 + len);
        const i = waiters.findIndex((w) => w.match(pkt));
        if (i >= 0) waiters.splice(i, 1)[0].resolve(pkt);
      }
    });
    const wait = (match) => new Promise((res) => waiters.push({ match, resolve: res }));
    const send = (pkt) => {
      const s = JSON.stringify(pkt);
      sock.write(Buffer.byteLength(s) + ':' + s);
    };
    const request = (to, type, extra = {}) => {
      const p = wait((m) => m.from === to && !m.type);
      send({ to, type, ...extra });
      return p;
    };
    (async () => {
      await wait((m) => m.from === 'root' && m.applicationType);
      const proc = await request('root', 'getProcess', { id: 0 });
      if (proc.error) throw new Error('the phone refused main-process debugging (' + proc.error + ').');
      const descriptor = proc.processDescriptor || proc.form;
      const target = await request(descriptor.actor, 'getTarget');
      if (target.error) throw new Error('the phone refused main-process debugging (' + target.error + ').');
      const consoleActor = (target.process || target.form).consoleActor;
      const result = wait((m) => m.from === consoleActor && m.type === 'evaluationResult');
      send({ to: consoleActor, type: 'evaluateJSAsync', text });
      const r = await result;
      if (r.exception) throw new Error('Gecko: ' + JSON.stringify(r.exceptionMessage));
      return r.result;
    })().then(
      (v) => {
        clearTimeout(timer);
        sock.end();
        resolvePromise(v);
      },
      (e) => {
        clearTimeout(timer);
        sock.destroy();
        reject(e);
      }
    );
  });
}

function certScript(mode, der) {
  const b64 = der.toString('base64');
  const fp = createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':');
  return `(function () {
  const db = Cc['@mozilla.org/security/x509certdb;1'].getService(Ci.nsIX509CertDB);
  const find = () => {
    const certs = db.getCerts();
    const all = Array.isArray(certs) ? certs : Array.from(certs.getEnumerator());
    return all.find((c) => c.sha256Fingerprint === '${fp}') || null;
  };
  let cert = find();
  if (${JSON.stringify(mode)} === 'install') {
    if (!cert) cert = db.addCertFromBase64('${b64}', 'C,,');
    db.setCertTrust(cert, Ci.nsIX509Cert.CA_CERT, Ci.nsIX509CertDB.TRUSTED_SSL);
  } else if (${JSON.stringify(mode)} === 'remove' && cert) {
    db.deleteCertificate(cert);
    cert = find();
  }
  const trusted = !!cert && db.isCertTrusted(cert, Ci.nsIX509Cert.CA_CERT, Ci.nsIX509CertDB.TRUSTED_SSL);
  return (cert ? 'present' : 'absent') + ', ' + (trusted ? 'trusted' : 'not trusted');
})()`;
}

const [mode = 'status', arg] = process.argv.slice(2);
if (!['install', 'status', 'remove', 'restore'].includes(mode)) fail('unknown command "' + mode + '". Use install, status, remove, or restore <dir>.');

adb(['root'], { allowFail: true });
adb(['wait-for-device']);
const profile = profileDir();

if (mode === 'restore') {
  restore(profile, arg && resolve(arg));
  process.exit(0);
}

if (mode !== 'status') backup(profile);
forwardDebugger();
try {
  const state = await evalInParent(certScript(mode, readFileSync(CERT)));
  console.log('Signal Messenger root certificate: ' + state);
  if (mode === 'install' && !/, trusted$/.test(state)) fail('Gecko did not keep the trust setting.');
  if (mode === 'install') console.log('OK: open Beacon and check Settings -> Debug -> Faster connection.');
  if (mode === 'remove') console.log('OK: Beacon goes back to its own TLS for everything the next time it starts.');
} catch (e) {
  fail(e.message);
} finally {
  adb(['forward', '--remove', 'tcp:' + PORT], { allowFail: true });
}

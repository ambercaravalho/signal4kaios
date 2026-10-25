/* Operator CLI, run next to the gateway (it shares the SQLite file):
     npm run link [name]     link a Signal account by scanning a QR code
     npm run pair            issue a new pairing code
     npm run devices         list paired devices
     npm run revoke <id>     unpair a device
     npm run push-test [number] [--empty] [--encoding aesgcm|aes128gcm]
                             send a test push to every subscription (all subscribed numbers if none given)
   In Docker: docker compose exec gateway npm run <command> */

import QRCode from 'qrcode';
import * as auth from './auth';
import * as push from './push';
import * as signal from './signal';
import { maskNumber } from './log';

const LINK_POLL_MS = 2000;
const LINK_TIMEOUT_MS = 3 * 60 * 1000;

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function sleep(ms: number): Promise<void> {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* Shows the link QR code, then waits for signal-cli-rest-api to list a new account. The URI is printed only as a QR code on the operator's terminal, never logged. */
function link(deviceName: string): Promise<number> {
  let before: string[] = [];
  return signal.listAccounts().then(function (nums) {
    before = nums;
    return signal.deviceLinkUri(deviceName);
  }).then(function (uri) {
    return QRCode.toString(uri, { type: 'terminal', small: true });
  }).then(function (qr) {
    console.log(qr);
    console.log('In Signal on your phone: Settings -> Linked devices -> Link a new device, then scan this code.');
    console.log('Waiting for the link to finish (up to ' + (LINK_TIMEOUT_MS / 60000) + ' minutes)...');
    const deadline = Date.now() + LINK_TIMEOUT_MS;
    function poll(): Promise<number> {
      return sleep(LINK_POLL_MS).then(function () {
        return signal.listAccounts()['catch'](function () { return [] as string[]; });
      }).then(function (nums) {
        const added = nums.filter(function (n) { return before.indexOf(n) === -1; });
        if (added.length) {
          console.log('\nLinked ' + added.map(maskNumber).join(', ') + '.');
          console.log('Next, pair the phone with the code in the gateway log (docker compose -f docker/docker-compose.yml logs gateway), or get a new one with: npm run pair');
          return 0;
        }
        if (Date.now() > deadline) {
          console.error('\nNo new account showed up. The code may have expired; run npm run link again.');
          return 1;
        }
        return poll();
      });
    }
    return poll();
  })['catch'](function (e: unknown) {
    console.error('Could not start linking: ' + errMsg(e));
    console.error('Check that the signal-cli-rest-api container is running (docker compose -f docker/docker-compose.yml ps).');
    return 1;
  });
}

/* Pushes a canned note (or an empty tickle with --empty) to every subscription, ignoring the idle gate, and prints what the push service answered. Endpoints are masked by push.sendTest. */
function pushTest(args: string[]): Promise<number> {
  let empty = false;
  let encoding: push.Encoding | undefined;
  let number = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--empty') empty = true;
    else if (a === '--encoding') {
      const v = args[++i];
      if (v !== 'aesgcm' && v !== 'aes128gcm') {
        console.error('--encoding must be aesgcm or aes128gcm');
        return Promise.resolve(1);
      }
      encoding = v;
    } else number = a;
  }
  push.init();
  const numbers = number ? [number] : push.subscribedNumbers();
  if (!numbers.length) {
    console.error('No push subscriptions. Open the app on the phone once so it registers.');
    return Promise.resolve(1);
  }
  return Promise.all(numbers.map(function (n) {
    return push.sendTest(n, empty, encoding).then(function (results) {
      if (!results.length) console.log(maskNumber(n) + ': no subscriptions');
      results.forEach(function (r) {
        console.log(maskNumber(n) + '\t' + r.endpoint + '\t' +
          (r.statusCode != null ? r.statusCode : '-') + (r.error ? '\t' + r.error : ''));
      });
      return results.some(function (r) { return !!r.error; });
    });
  })).then(function (failed) {
    return failed.some(Boolean) ? 1 : 0;
  });
}

function main(argv: string[]): number | Promise<number> {
  const cmd = argv[0];
  if (cmd === 'link') {
    return link(argv.slice(1).join(' ').trim() || 'signal4kaios');
  }
  if (cmd === 'pair') {
    const c = auth.issueCode();
    console.log(auth.pairingBanner(c.code, c.expiresAt));
    return 0;
  }
  if (cmd === 'devices') {
    const rows = auth.list();
    if (!rows.length) {
      console.log('No paired devices. Run: npm run pair');
      return 0;
    }
    rows.forEach(function (d) {
      console.log(d.id + '\t' + d.name + '\tpaired ' + fmtTime(d.created_at) +
        '\tlast seen ' + fmtTime(d.last_seen));
    });
    return 0;
  }
  if (cmd === 'revoke') {
    const id = parseInt(argv[1] || '', 10);
    if (isNaN(id)) {
      console.error('Usage: npm run revoke <device id>  (see npm run devices)');
      return 1;
    }
    if (!auth.revoke(id)) {
      console.error('No device with id ' + id);
      return 1;
    }
    console.log('Revoked device ' + id + '. It must pair again to reconnect.');
    return 0;
  }
  if (cmd === 'push-test') {
    return pushTest(argv.slice(1));
  }
  console.error('Usage: cli.js link [name] | pair | devices | revoke <id> | push-test [number] [--empty] [--encoding aesgcm|aes128gcm]');
  return 1;
}

Promise.resolve(main(process.argv.slice(2))).then(function (code) {
  process.exitCode = code;
});

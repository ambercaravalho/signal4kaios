/* Operator CLI, run next to the gateway (it shares the SQLite file):
     npm run pair            issue a new pairing code
     npm run devices         list paired devices
     npm run revoke <id>     unpair a device
   In Docker: docker compose exec gateway npm run <command> */

import * as auth from './auth';

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function main(argv: string[]): number {
  const cmd = argv[0];
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
  console.error('Usage: cli.js pair | devices | revoke <id>');
  return 1;
}

process.exitCode = main(process.argv.slice(2));

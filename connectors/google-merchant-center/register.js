#!/usr/bin/env node
/**
 * Register this workspace's Google Cloud project with a Merchant Center account.
 *
 *   node connectors/google-merchant-center/register.js --account 123456789 --email <your email>
 *   node connectors/google-merchant-center/register.js --account 123456789 --email <your email> --commit
 *
 * The Merchant API refuses calls from a Cloud project that has not been
 * registered with the account, and says so only as a permission error. This is
 * a one-time setup write to the Merchant Center account, so it is a dry run
 * unless --commit is passed. The developer email is who Google contacts about
 * API changes; it must be a user on the account.
 */
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MerchantClient } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '..', 'env.local'), quiet: true });

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const account = flag('--account');
const email = flag('--email');
const commit = argv.includes('--commit');

if (!account || !email) {
  console.error('usage: register.js --account <merchant id> --email <developer email> [--commit]');
  process.exit(1);
}

// The one write this connector makes goes only to an account this workspace
// is allowed to touch.
const allowed = (process.env.MERCHANT_ACCOUNT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (!allowed.includes(account)) {
  console.error(`Account ${account} is not in MERCHANT_ACCOUNT_IDS (env.local). Add it there first.`);
  process.exit(1);
}

if (!commit) {
  console.log(`Dry run: would register this Cloud project with Merchant Center account ${account},`);
  console.log(`developer contact ${email}. Re-run with --commit to do it.`);
  process.exit(0);
}

new MerchantClient({ verbose: true }).registerGcp(account, email)
  .then((res) => {
    console.log(`✅ Registered with account ${account}.`);
    if (res && Object.keys(res).length) console.log(JSON.stringify(res, null, 2));
  })
  .catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });

#!/usr/bin/env node
'use strict';

/*
 * Fetch the Bluetooth offline key + slot for Yale/August locks.
 *
 * Yale Home only allows OAuth login via Home Assistant, so this script reuses the
 * token Home Assistant's Yale integration stores. Usage:
 *
 *   node tools/get-offline-key.js /path/to/ha-config/.storage/core.config_entries
 *   node tools/get-offline-key.js --token <access_token> [--brand yale_global|yale_august|august]
 *
 * API details from the yalexs library used by Home Assistant.
 */

const fs = require('fs');

const BRANDS = {
  yale_global: {
    baseUrl: 'https://api.aaecosystem.com',
    tokenHeader: 'x-access-token',
    apiKeyHeader: 'x-api-key',
    brandingHeader: 'x-branding',
    apiKey: 'd16a1029-d823-4b55-a4ce-a769a9b56f0e',
    branding: 'yale',
  },
  yale_august: {
    baseUrl: 'https://api-production.august.com',
    tokenHeader: 'x-august-access-token',
    apiKeyHeader: 'x-august-api-key',
    brandingHeader: 'x-august-branding',
    apiKey: '66814fd9-af2c-426c-9710-b37e7eadfb51',
    branding: 'august',
  },
  august: {
    baseUrl: 'https://api-production.august.com',
    tokenHeader: 'x-august-access-token',
    apiKeyHeader: 'x-august-api-key',
    brandingHeader: 'x-august-branding',
    apiKey: 'd9984f29-07a6-816e-e1c9-44ec9d1be431',
    branding: 'august',
  },
};

function fail(msg) {
  console.error(`Feil: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { brand: null, token: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--token') args.token = argv[++i];
    else if (argv[i] === '--brand') args.brand = argv[++i];
    else args.file = argv[i];
  }
  return args;
}

function tokenFromHomeAssistant(file) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`Kunne ikke lese ${file}: ${err.message}`);
  }
  const entries = (json.data && json.data.entries) || [];
  const entry = entries.find((e) => ['yale', 'august'].includes(e.domain) && e.data && e.data.token);
  if (!entry) fail('Fant ingen Yale-integrasjon med token i filen. Er Yale-integrasjonen lagt til i Home Assistant?');
  const brand = entry.domain === 'yale' ? 'yale_global' : (entry.data.brand || 'yale_august');
  const { token } = entry.data;
  if (token.expires_at && token.expires_at * 1000 < Date.now()) {
    console.error('Advarsel: tokenet ser utløpt ut. Start Home Assistant på nytt (det fornyer tokenet) og prøv igjen.');
  }
  return { token: token.access_token, brand };
}

async function api(brand, token, path) {
  const b = BRANDS[brand];
  const res = await fetch(b.baseUrl + path, {
    headers: {
      [b.tokenHeader]: token,
      [b.apiKeyHeader]: b.apiKey,
      [b.brandingHeader]: b.branding,
      'Accept-Version': '0.0.1',
      'Content-Type': 'application/json; charset=UTF-8',
      'x-august-country': 'US',
      'User-Agent': 'August/Luna-22.17.0 (Android; SDK 31; gphone64_arm64)',
    },
  });
  if (res.status === 401) fail('Tokenet ble avvist (401). Start Home Assistant på nytt for å fornye det, og prøv igjen.');
  if (!res.ok) fail(`${path} svarte ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let { token, brand } = args;
  if (args.file) ({ token, brand } = tokenFromHomeAssistant(args.file));
  if (!token) {
    console.log('Bruk: node tools/get-offline-key.js <ha-config>/.storage/core.config_entries');
    console.log('   eller: node tools/get-offline-key.js --token <access_token> [--brand yale_global]');
    process.exit(1);
  }
  brand = args.brand || brand || 'yale_global';
  if (!BRANDS[brand]) fail(`Ukjent brand ${brand}`);

  const locks = await api(brand, token, '/users/locks/mine');
  const ids = Object.keys(locks);
  if (!ids.length) fail('Kontoen har ingen låser.');

  for (const id of ids) {
    const detail = await api(brand, token, `/locks/${id}`);
    const loaded = (detail.OfflineKeys && detail.OfflineKeys.loaded) || [];
    console.log(`\n${detail.LockName || locks[id].LockName || id}`);
    console.log(`  Serienummer:       ${detail.SerialNumber || 'ukjent'}`);
    if (loaded.length && loaded[0].key) {
      console.log(`  Offline-nøkkel:    ${loaded[0].key}`);
      console.log(`  Slot:              ${loaded[0].slot}`);
    } else {
      console.log('  Ingen offline-nøkkel funnet. Kontoen må være eier/admin, og du må ha');
      console.log('  åpnet låsen med Yale Home-appen over Bluetooth minst én gang.');
    }
  }
}

main().catch((err) => fail(err.message));

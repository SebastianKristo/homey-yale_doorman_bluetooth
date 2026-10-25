'use strict';

const Homey = require('homey');
const { SERVICE_UUID, normUuid } = require('../../lib/YaleBle');

// Bluetooth company ids used by August/Yale locks
const MANUFACTURER_IDS = [0x01d1, 0x012e, 0x0bde];

const NAME_PATTERN = /yale|doorman|august|linus|assa/i;

function isYale(adv) {
  if ((adv.serviceUuids || []).some((u) => normUuid(u) === SERVICE_UUID)) return true;
  if (adv.localName && NAME_PATTERN.test(adv.localName)) return true;
  const md = adv.manufacturerData ? Buffer.from(adv.manufacturerData) : null;
  return !!(md && md.length >= 2 && MANUFACTURER_IDS.includes(md.readUInt16LE(0)));
}

function describe(adv) {
  const md = adv.manufacturerData ? Buffer.from(adv.manufacturerData).toString('hex') : '-';
  return `${adv.address} name=${adv.localName || '-'} rssi=${adv.rssi} services=${(adv.serviceUuids || []).join(',') || '-'} mfr=${md}`;
}

class YaleLockDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getActionCard('refresh_status')
      .registerRunListener(({ device }) => device.refreshStatus());
    this.homey.flow.getConditionCard('is_reachable')
      .registerRunListener(({ device }) => device.reachable === true);
  }

  async onPair(session) {
    let credentials = null;

    session.setHandler('credentials', async ({
      key, slot, proxyHost, proxyKey,
    }) => {
      const k = String(key || '').trim().toLowerCase();
      const s = Number(slot);
      if (!/^[0-9a-f]{32}$/.test(k)) throw new Error(this.homey.__('pair.invalid_key'));
      if (!Number.isInteger(s) || s < 0 || s > 255) throw new Error(this.homey.__('pair.invalid_slot'));
      const host = String(proxyHost || '').trim();
      const encryptionKey = String(proxyKey || '').trim();
      if (encryptionKey && Buffer.from(encryptionKey, 'base64').length !== 32) {
        throw new Error(this.homey.__('pair.invalid_proxy_key'));
      }
      credentials = {
        key: k, slot: s, proxyHost: host, proxyKey: encryptionKey,
      };
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (credentials && credentials.proxyHost) return this.listViaProxy(credentials);

      const advertisements = await this.homey.ble.discover([], 20000);
      this.log(`Found ${advertisements.length} BLE devices`);
      advertisements.forEach((adv) => this.log(`  ${isYale(adv) ? '*' : ' '} ${describe(adv)}`));

      // If nothing is recognised as a Yale lock, show every device (strongest signal first)
      // so the user can still pick the lock, e.g. when it advertises without manufacturer data
      let candidates = advertisements.filter(isYale);
      const fallback = candidates.length === 0;
      if (fallback) candidates = [...advertisements].sort((a, b) => (b.rssi || -999) - (a.rssi || -999));

      return candidates.map((adv) => ({
        name: fallback
          ? `${adv.localName || this.homey.__('pair.unknown_device')} (${adv.address}, ${adv.rssi} dBm)`
          : adv.localName || `Yale ${adv.address}`,
        data: { id: adv.uuid },
        store: {
          peripheralUuid: adv.uuid,
          address: adv.address,
        },
        settings: {
          offline_key: credentials ? credentials.key : '',
          offline_slot: credentials ? credentials.slot : 1,
        },
      }));
    });
  }

  async listViaProxy(credentials) {
    const { getProxy } = require('../../lib/EspProxy');
    const proxy = getProxy({
      host: credentials.proxyHost,
      encryptionKey: credentials.proxyKey,
      log: (...a) => this.log(...a),
    });
    const found = await proxy.scan(15000);
    this.log(`Proxy ${credentials.proxyHost} found ${found.length} BLE devices`);

    const isYaleAdv = (a) => a.serviceUuids.some((u) => normUuid(u) === SERVICE_UUID)
      || a.manufacturerIds.some((id) => MANUFACTURER_IDS.includes(id))
      || NAME_PATTERN.test(a.name);
    let candidates = found.filter(isYaleAdv);
    const fallback = candidates.length === 0;
    if (fallback) candidates = found.sort((a, b) => b.rssi - a.rssi);

    return candidates.map((a) => {
      const id = a.address.replace(/:/g, '');
      return {
        name: fallback
          ? `${a.name || this.homey.__('pair.unknown_device')} (${a.address}, ${a.rssi} dBm)`
          : a.name || `Yale ${a.address}`,
        data: { id },
        store: { peripheralUuid: id, address: a.address },
        settings: {
          offline_key: credentials.key,
          offline_slot: credentials.slot,
          proxy_host: credentials.proxyHost,
          proxy_key: credentials.proxyKey,
        },
      };
    });
  }

}

module.exports = YaleLockDriver;

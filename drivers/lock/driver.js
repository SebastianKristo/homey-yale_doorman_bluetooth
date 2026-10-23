'use strict';

const Homey = require('homey');
const { SERVICE_UUID, normUuid } = require('../../lib/YaleBle');

// Bluetooth company ids used by August/Yale locks
const MANUFACTURER_IDS = [0x01d1, 0x012e, 0x0bde];

function isYale(adv) {
  if ((adv.serviceUuids || []).some((u) => normUuid(u) === SERVICE_UUID)) return true;
  const md = adv.manufacturerData;
  return !!(md && md.length >= 2 && MANUFACTURER_IDS.includes(md.readUInt16LE(0)));
}

class YaleLockDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getActionCard('refresh_status')
      .registerRunListener(({ device }) => device.refreshStatus());
  }

  async onPair(session) {
    let credentials = null;

    session.setHandler('credentials', async ({ key, slot }) => {
      const k = String(key || '').trim().toLowerCase();
      const s = Number(slot);
      if (!/^[0-9a-f]{32}$/.test(k)) throw new Error(this.homey.__('pair.invalid_key'));
      if (!Number.isInteger(s) || s < 0 || s > 255) throw new Error(this.homey.__('pair.invalid_slot'));
      credentials = { key: k, slot: s };
      return true;
    });

    session.setHandler('list_devices', async () => {
      const advertisements = await this.homey.ble.discover([], 15000);
      return advertisements.filter(isYale).map((adv) => ({
        name: adv.localName || `Yale ${adv.address}`,
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

}

module.exports = YaleLockDriver;

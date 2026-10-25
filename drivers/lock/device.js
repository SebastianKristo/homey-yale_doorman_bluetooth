'use strict';

const Homey = require('homey');
const { YaleLock } = require('../../lib/YaleBle');

const PROXY_SCAN_MS = 5000;
const VERIFY_DELAY_MS = 6000;
const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;

const IDLE_DISCONNECT_MS = 20 * 1000;

class YaleLockDevice extends Homey.Device {

  async onInit() {
    this.lastManufacturerData = null;
    // Devices paired before battery support was added
    for (const cap of ['measure_battery', 'alarm_battery']) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }
    this.registerCapabilityListener('locked', async (value) => {
      const action = value ? 'lock' : 'unlock';
      try {
        await this.withLock(async (lock) => {
          if (value) await lock.lock();
          else await lock.unlock();
        });
      } catch (err) {
        // Let a Flow take over, e.g. via the Yale Home (cloud) app and Wi-Fi bridge
        await this.homey.flow.getDeviceTriggerCard('local_failed')
          .trigger(this, { action, error: err.message })
          .catch(this.error);
        throw err;
      }
      // Return as soon as the lock has accepted the command. The lock pushes the
      // result when the motor stops; read the state afterwards as a fallback.
      this.homey.clearTimeout(this.verifyTimer);
      this.verifyTimer = this.homey.setTimeout(() => {
        this.refreshStatus({ battery: false }).catch((e) => this.error('Verify failed', e.message));
      }, VERIFY_DELAY_MS);
    });

    this.createLock();
    this.scheduleTimers();
    this.refreshStatus().catch((err) => this.error('Initial status failed', err.message));
  }

  get proxyConfig() {
    const host = String(this.getSetting('proxy_host') || '').trim();
    if (!host) return null;
    return { host, encryptionKey: String(this.getSetting('proxy_key') || '').trim() };
  }

  get mac() {
    const { address, peripheralUuid } = this.getStore();
    return address || peripheralUuid;
  }

  createLock() {
    const { offline_key: key, offline_slot: slot } = this.getSettings();
    const proxy = this.proxyConfig;
    this.lock = null;
    try {
      this.lock = new YaleLock({
        homey: this.homey,
        peripheralUuid: this.getStore().peripheralUuid,
        key,
        slot,
        log: (...a) => this.log(...a),
        openPeripheral: proxy
          ? () => require('../../lib/EspProxy').connectViaProxy({
            ...proxy, mac: this.mac, log: (...a) => this.log(...a),
          })
          : undefined,
      });
      this.lock.on('status', (s) => this.applyStatus(s).catch(this.error));
      this.lock.on('battery', (b) => this.applyBattery(b).catch(this.error));
      this.lock.on('disconnected', () => this.scheduleReconnect());
      this.setAvailable().catch(this.error);
    } catch (err) {
      this.setUnavailable(this.homey.__('device.missing_key')).catch(this.error);
    }
  }

  get alwaysConnected() {
    return !!this.getSetting('always_connected');
  }

  // Keep the link up in "always connected" mode, backing off while the lock is unreachable
  scheduleReconnect() {
    this.homey.clearTimeout(this.reconnectTimer);
    if (!this.alwaysConnected || this.stopped || !this.lock) return;
    const delay = this.reconnectDelay || RECONNECT_MIN_MS;
    this.reconnectTimer = this.homey.setTimeout(async () => {
      try {
        await this.withLock(async (lock) => {
          await lock.connect();
          await this.applyStatus(await lock.status());
        });
        this.reconnectDelay = RECONNECT_MIN_MS;
      } catch (err) {
        this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
        this.log(`Reconnect failed, next try in ${Math.round(this.reconnectDelay / 1000)} s`);
        this.scheduleReconnect();
      }
    }, delay);
  }

  scheduleTimers() {
    this.homey.clearInterval(this.pollTimer);
    this.homey.clearInterval(this.scanTimer);
    const { poll_interval: poll, scan_interval: scan } = this.getSettings();
    if (poll > 0) {
      this.pollTimer = this.homey.setInterval(
        () => this.refreshStatus().catch((e) => this.error('Poll failed', e.message)),
        poll * 60 * 1000,
      );
    }
    if (scan > 0) {
      this.scanTimer = this.homey.setInterval(
        () => this.checkAdvertisement().catch((e) => this.error('Scan failed', e.message)),
        scan * 1000,
      );
    }
  }

  // The lock changes its advertised manufacturer data when its state changes.
  // A passive scan is cheap for the lock battery; only connect when it changes.
  async checkAdvertisement() {
    // Nothing to compare against while busy or without a usable key
    if (this.busy || !this.lock) return;
    // While connected the lock pushes its state itself
    if (this.lock.connected) return;
    const md = this.proxyConfig ? await this.proxyManufacturerData() : await this.homeyManufacturerData();
    if (md && this.lastManufacturerData && md !== this.lastManufacturerData) {
      this.log('Advertisement changed, reading status');
      await this.refreshStatus({ battery: false });
    }
    if (md) this.lastManufacturerData = md;
  }

  async homeyManufacturerData() {
    const adv = await this.homey.ble.find(this.getStore().peripheralUuid);
    return adv && adv.manufacturerData ? Buffer.from(adv.manufacturerData).toString('hex') : null;
  }

  async proxyManufacturerData() {
    const { getProxy } = require('../../lib/EspProxy');
    const proxy = getProxy({ ...this.proxyConfig, log: (...a) => this.log(...a) });
    const mac = this.mac.replace(/[^0-9a-f]/gi, '').toLowerCase();
    const found = (await proxy.scan(PROXY_SCAN_MS)).find((a) => a.address.replace(/:/g, '') === mac);
    return found ? found.manufacturerData : null;
  }

  async refreshStatus({ battery = true } = {}) {
    await this.withLock(async (lock) => {
      await this.applyStatus(await lock.status());
      if (battery) {
        // Battery is nice-to-have; don't fail the status refresh because of it
        await lock.battery()
          .then((b) => this.applyBattery(b))
          .catch((err) => this.error('Battery read failed', err.message));
      }
    });
  }

  async applyBattery({ voltage, percentage }) {
    this.log(`Battery: ${voltage} V (${percentage}%)`);
    // A near-zero voltage is a misread frame, not an empty battery
    if (voltage < 1) return;
    await this.setCapabilityValue('measure_battery', percentage);
    await this.setCapabilityValue('alarm_battery', percentage <= this.getSetting('battery_alarm'));
  }

  async applyStatus(status) {
    this.log('Status:', status);
    await this.setCapabilityValue('lock_state', status).catch(this.error);
    if (status === 'locked') await this.setCapabilityValue('locked', true);
    else if (status === 'unlocked') await this.setCapabilityValue('locked', false);
  }

  async withLock(fn) {
    if (!this.lock) throw new Error(this.homey.__('device.missing_key'));
    this.homey.clearTimeout(this.idleTimer);
    this.busy = (this.busy || 0) + 1;
    try {
      let result;
      try {
        result = await fn(this.lock);
      } catch (err) {
        // One retry with a fresh connection
        this.log('Retrying after error:', err.message);
        await this.lock.disconnect().catch(() => {});
        result = await fn(this.lock);
      }
      this.reachable = true;
      this.setAvailable().catch(this.error);
      return result;
    } catch (err) {
      this.reachable = false;
      this.error(err);
      throw err;
    } finally {
      this.busy -= 1;
      // Stay connected briefly to receive pushed state updates, then free the BLE link
      if (!this.alwaysConnected) {
        this.idleTimer = this.homey.setTimeout(() => {
          if (!this.busy && this.lock) this.lock.disconnect().catch(this.error);
        }, IDLE_DISCONNECT_MS);
      } else if (this.lock && !this.lock.connected) {
        this.scheduleReconnect();
      }
    }
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.some((k) => k.startsWith('offline_') || k.startsWith('proxy_'))) {
      if (this.lock) await this.lock.disconnect().catch(() => {});
      // New settings are only readable after onSettings resolves
      this.homey.setTimeout(() => {
        this.createLock();
        this.refreshStatus().catch((e) => this.error(e.message));
      }, 500);
    }
    if (changedKeys.includes('always_connected')) {
      this.homey.setTimeout(() => {
        this.reconnectDelay = RECONNECT_MIN_MS;
        if (this.alwaysConnected) this.scheduleReconnect();
        else if (this.lock && !this.busy) this.lock.disconnect().catch(this.error);
      }, 500);
    }
    if (changedKeys.some((k) => k.endsWith('_interval'))) {
      this.homey.setTimeout(() => this.scheduleTimers(), 500);
    }
  }

  async onUninit() {
    this.stopped = true;
    this.homey.clearTimeout(this.reconnectTimer);
    this.homey.clearTimeout(this.verifyTimer);
    this.homey.clearTimeout(this.idleTimer);
    this.homey.clearInterval(this.pollTimer);
    this.homey.clearInterval(this.scanTimer);
    if (this.lock) await this.lock.disconnect().catch(() => {});
  }

  async onDeleted() {
    await this.onUninit();
  }

}

module.exports = YaleLockDevice;

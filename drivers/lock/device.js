'use strict';

const Homey = require('homey');
const { YaleLock } = require('../../lib/YaleBle');

const IDLE_DISCONNECT_MS = 20 * 1000;

class YaleLockDevice extends Homey.Device {

  async onInit() {
    this.lastManufacturerData = null;
    // Devices paired before battery support was added
    for (const cap of ['measure_battery', 'alarm_battery']) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }
    this.registerCapabilityListener('locked', async (value) => {
      await this.withLock(async (lock) => {
        if (value) await lock.lock();
        else await lock.unlock();
        // Give the motor time to finish, then read real state
        await new Promise((r) => this.homey.setTimeout(r, 4000));
        await this.applyStatus(await lock.status());
      });
    });

    this.createLock();
    this.scheduleTimers();
    this.refreshStatus().catch((err) => this.error('Initial status failed', err.message));
  }

  createLock() {
    const { offline_key: key, offline_slot: slot } = this.getSettings();
    this.lock = null;
    try {
      this.lock = new YaleLock({
        homey: this.homey,
        peripheralUuid: this.getStore().peripheralUuid,
        key,
        slot,
        log: (...a) => this.log(...a),
      });
      this.lock.on('status', (s) => this.applyStatus(s).catch(this.error));
      this.lock.on('battery', (b) => this.applyBattery(b).catch(this.error));
      this.setAvailable().catch(this.error);
    } catch (err) {
      this.setUnavailable(this.homey.__('device.missing_key')).catch(this.error);
    }
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
    const adv = await this.homey.ble.find(this.getStore().peripheralUuid);
    const md = adv && adv.manufacturerData ? Buffer.from(adv.manufacturerData).toString('hex') : null;
    if (md && this.lastManufacturerData && md !== this.lastManufacturerData) {
      this.log('Advertisement changed, reading status');
      await this.refreshStatus({ battery: false });
    }
    if (md) this.lastManufacturerData = md;
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
      this.setAvailable().catch(this.error);
      return result;
    } catch (err) {
      this.error(err);
      throw err;
    } finally {
      this.busy -= 1;
      // Stay connected briefly to receive pushed state updates, then free the BLE link
      this.idleTimer = this.homey.setTimeout(() => {
        if (!this.busy && this.lock) this.lock.disconnect().catch(this.error);
      }, IDLE_DISCONNECT_MS);
    }
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.some((k) => k.startsWith('offline_'))) {
      if (this.lock) await this.lock.disconnect().catch(() => {});
      // New settings are only readable after onSettings resolves
      this.homey.setTimeout(() => {
        this.createLock();
        this.refreshStatus().catch((e) => this.error(e.message));
      }, 500);
    }
    if (changedKeys.some((k) => k.endsWith('_interval'))) {
      this.homey.setTimeout(() => this.scheduleTimers(), 500);
    }
  }

  async onUninit() {
    this.homey.clearInterval(this.pollTimer);
    this.homey.clearInterval(this.scanTimer);
    if (this.lock) await this.lock.disconnect().catch(() => {});
  }

  async onDeleted() {
    await this.onUninit();
  }

}

module.exports = YaleLockDevice;

'use strict';

/*
 * Talk to a BLE device through an ESPHome Bluetooth proxy (e.g. Everything
 * Presence One) using the ESPHome native API, the same way Home Assistant does.
 *
 * Exposes a peripheral that looks like Homey's BlePeripheral (the subset
 * YaleLock uses), so the lock protocol code doesn't care which radio is used.
 */

const { EventEmitter } = require('events');

const CCCD_UUID = '00002902-0000-1000-8000-00805f9b34fb';
const BT_BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const CONNECT_TIMEOUT_S = 20;
const GATT_TIMEOUT_MS = 10000;
const PROP_NOTIFY = 0x10;
const PROP_INDICATE = 0x20;

function macToNumber(mac) {
  return parseInt(String(mac).replace(/[^0-9a-f]/gi, ''), 16);
}

function numberToMac(n) {
  return n.toString(16).padStart(12, '0').match(/../g).join(':');
}

// Newer ESPHome sends 16/32-bit UUIDs in short_uuid instead of uuid_list
function fullUuid({ uuid, shortUuid }) {
  if (uuid) return uuid.toLowerCase();
  return `${(shortUuid >>> 0).toString(16).padStart(8, '0')}${BT_BASE_SUFFIX}`;
}

// GATT UUIDs are sent as repeated uint64. Read them as strings: JS numbers lose
// precision above 2^53, which garbles 128-bit UUIDs. Packed uint64 lists are
// only used for these UUIDs in the ESPHome API, so this is safe to apply globally.
// (Also requires google-protobuf 3.x, see "overrides" in package.json.)
let protobufPatched = false;
function patchProtobuf() {
  if (protobufPatched) return;
  const reader = require('google-protobuf').BinaryReader.prototype;
  reader.readPackedUint64 = reader.readPackedUint64String;
  protobufPatched = true;
}

class ProxyConnection {

  constructor({ host, encryptionKey, log }) {
    this.host = host;
    this.log = log;
    // Loaded lazily: users without a proxy never pay for protobuf/noise
    patchProtobuf();
    const { Connection } = require('@2colors/esphome-native-api');
    const [hostname, port] = String(host).split(':');
    this.conn = new Connection({
      host: hostname,
      port: port ? Number(port) : 6053,
      encryptionKey: encryptionKey || '',
      clientInfo: 'Homey Yale Local Bluetooth',
      reconnect: true,
      reconnectInterval: 15000,
    });
    this.conn.on('error', (err) => this.log(`ESPHome ${host}: ${err.message}`));
    this.queue = Promise.resolve();
    this.ready = null;
  }

  async connect() {
    if (this.conn.connected && this.conn.authorized) return;
    if (!this.ready) {
      this.ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`ESPHome proxy ${this.host} did not respond`));
        }, 15000);
        const onAuth = () => { cleanup(); resolve(); };
        const onError = (err) => { cleanup(); reject(err); };
        const cleanup = () => {
          clearTimeout(timer);
          this.conn.off('authorized', onAuth);
          this.conn.off('error', onError);
        };
        this.conn.once('authorized', onAuth);
        this.conn.once('error', onError);
        if (!this.conn.connected) this.conn.connect();
      }).finally(() => { this.ready = null; });
    }
    await this.ready;
  }

  // The library matches responses by message type only, so run one request at a time
  run(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  // Await a GATT response, failing fast on a GATT error for the same handle
  gatt(address, handle, fn) {
    return this.run(() => new Promise((resolve, reject) => {
      const onError = (msg) => {
        if (msg.address !== address || msg.handle !== handle) return;
        cleanup();
        reject(new Error(`GATT error ${msg.error} on handle ${handle}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout on handle ${handle}`));
      }, GATT_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        this.conn.off('message.BluetoothGATTErrorResponse', onError);
      };
      this.conn.on('message.BluetoothGATTErrorResponse', onError);
      fn().then((r) => { cleanup(); resolve(r); }, (e) => { cleanup(); reject(e); });
    }));
  }

  /**
   * Listen for advertisements for a while.
   * @returns {Promise<Array<{address: string, name: string, rssi: number, manufacturerIds: number[], manufacturerData: string, serviceUuids: string[]}>>}
   */
  async scan(durationMs) {
    await this.connect();
    const found = new Map();
    const onAdv = (adv) => {
      found.set(adv.address, {
        address: numberToMac(adv.address),
        addressType: adv.addressType,
        name: adv.name || (found.get(adv.address) || {}).name || '',
        rssi: adv.rssi,
        manufacturerIds: (adv.manufacturerDataList || []).map((m) => parseInt(m.uuid.slice(0, 8), 16)),
        manufacturerData: (adv.manufacturerDataList || [])
          .map((m) => Buffer.from(m.legacyDataList || m.data || []).toString('hex')).join(','),
        serviceUuids: adv.serviceUuidsList || [],
      });
    };
    this.conn.on('message.BluetoothLEAdvertisementResponse', onAdv);
    this.conn.subscribeBluetoothAdvertisementService();
    await new Promise((r) => setTimeout(r, durationMs));
    this.conn.off('message.BluetoothLEAdvertisementResponse', onAdv);
    try { this.conn.unsubscribeBluetoothAdvertisementService(); } catch (err) { /* connection gone */ }
    return [...found.values()];
  }

  close() {
    this.conn.reconnect = false;
    this.conn.disconnect();
  }

}

class ProxyCharacteristic {

  constructor(peripheral, info) {
    this.peripheral = peripheral;
    this.uuid = fullUuid(info);
    this.handle = info.handle;
    this.properties = info.properties || 0;
    this.descriptors = (info.descriptorsList || []).map((d) => ({ uuid: fullUuid(d), handle: d.handle }));
  }

  get proxy() {
    return this.peripheral.proxy;
  }

  async write(data) {
    const { address } = this.peripheral;
    await this.proxy.gatt(address, this.handle,
      () => this.proxy.conn.writeBluetoothGATTCharacteristicService(address, this.handle, Buffer.from(data), true));
  }

  async read() {
    const { address } = this.peripheral;
    const res = await this.proxy.gatt(address, this.handle,
      () => this.proxy.conn.readBluetoothGATTCharacteristicService(address, this.handle));
    return Buffer.from(res.data || '', 'base64');
  }

  async subscribeToNotifications(callback) {
    const { address } = this.peripheral;
    this.peripheral.notifyHandlers.set(this.handle, callback);
    await this.proxy.gatt(address, this.handle,
      () => this.proxy.conn.notifyBluetoothGATTCharacteristicService(address, this.handle));
    // With V3 connections the client enables notifications in the CCCD itself
    const cccd = this.descriptors.find((d) => d.uuid === CCCD_UUID);
    if (cccd) {
      const value = (this.properties & PROP_NOTIFY) || !(this.properties & PROP_INDICATE)
        ? Buffer.from([0x01, 0x00]) : Buffer.from([0x02, 0x00]);
      await this.proxy.gatt(address, cccd.handle,
        () => this.proxy.conn.writeBluetoothGATTDescriptorService(address, cccd.handle, value));
    }
  }

}

class ProxyPeripheral extends EventEmitter {

  constructor(proxy, mac) {
    super();
    this.proxy = proxy;
    this.address = macToNumber(mac);
    this.services = [];
    this.notifyHandlers = new Map();

    this.onNotify = (msg) => {
      if (msg.address !== this.address) return;
      const cb = this.notifyHandlers.get(msg.handle);
      if (cb) cb(Buffer.from(msg.data || '', 'base64'));
    };
    this.onConnection = (msg) => {
      if (msg.address === this.address && !msg.connected) this._closed();
    };
    this.onProxyClose = () => this._closed();
  }

  async connect() {
    const { conn } = this.proxy;
    const res = await this.proxy.run(() => conn.connectBluetoothDeviceService(this.address));
    if (!res.connected) throw new Error(`Proxy could not connect to lock (error ${res.error})`);
    conn.on('message.BluetoothGATTNotifyDataResponse', this.onNotify);
    conn.on('message.BluetoothDeviceConnectionResponse', this.onConnection);
    conn.on('unauthorized', this.onProxyClose);
  }

  async discoverServices() {
    const { servicesList } = await this.proxy.run(
      () => this.proxy.conn.listBluetoothGATTServicesService(this.address),
    );
    this.services = servicesList.map((s) => {
      const characteristics = (s.characteristicsList || []).map((c) => new ProxyCharacteristic(this, c));
      return {
        uuid: fullUuid(s),
        characteristics,
        discoverCharacteristics: async () => characteristics,
      };
    });
    return this.services;
  }

  async disconnect() {
    if (this.closed) return;
    try {
      await this.proxy.run(() => this.proxy.conn.disconnectBluetoothDeviceService(this.address));
    } catch (err) {
      // Already gone
    }
    this._closed();
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    const { conn } = this.proxy;
    conn.off('message.BluetoothGATTNotifyDataResponse', this.onNotify);
    conn.off('message.BluetoothDeviceConnectionResponse', this.onConnection);
    conn.off('unauthorized', this.onProxyClose);
    this.notifyHandlers.clear();
    this.emit('disconnect');
  }

}

// One connection per proxy, shared by all devices using it
const pool = new Map();

function getProxy({ host, encryptionKey, log }) {
  const id = `${host}|${encryptionKey || ''}`;
  if (!pool.has(id)) pool.set(id, new ProxyConnection({ host, encryptionKey, log }));
  return pool.get(id);
}

function releaseProxy({ host, encryptionKey }) {
  const id = `${host}|${encryptionKey || ''}`;
  const proxy = pool.get(id);
  if (proxy) {
    proxy.close();
    pool.delete(id);
  }
}

async function connectViaProxy({ host, encryptionKey, mac, log }) {
  const proxy = getProxy({ host, encryptionKey, log });
  await proxy.connect();
  const peripheral = new ProxyPeripheral(proxy, mac);
  await peripheral.connect();
  return peripheral;
}

module.exports = {
  getProxy, releaseProxy, connectViaProxy, macToNumber, numberToMac,
};

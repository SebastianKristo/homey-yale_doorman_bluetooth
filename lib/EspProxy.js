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
const CONNECT_TIMEOUT_MS = 20000;
const DISCONNECT_TIMEOUT_MS = 5000;
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
    this.queue = Promise.resolve();
    this.ready = null;
    this.createConnection(encryptionKey);
  }

  createConnection(encryptionKey) {
    // Loaded lazily: users without a proxy never pay for protobuf/noise
    patchProtobuf();
    const { Connection } = require('@2colors/esphome-native-api');
    const [hostname, port] = String(this.host).split(':');
    this.encrypted = !!encryptionKey;
    this.conn = new Connection({
      host: hostname,
      port: port ? Number(port) : 6053,
      encryptionKey: encryptionKey || '',
      clientInfo: 'Homey Yale Local Bluetooth',
      // Reconnect on demand (connect() is called before every use) instead of
      // retrying a proxy that is down every 15 s forever
      reconnect: false,
    });
    this.conn.on('error', (err) => this.log(`ESPHome ${this.host}: ${err.message}`));
    // Track the proxy's free Bluetooth connection slots (an ESP32 has only a few)
    this.slots = null;
    this.conn.on('message.BluetoothConnectionsFreeResponse', (msg) => {
      this.slots = {
        free: msg.free,
        limit: msg.limit,
        allocated: (msg.allocatedList || []).map(Number).filter(Boolean),
      };
    });
    this.conn.on('authorized', () => {
      try {
        const { pb } = require('@2colors/esphome-native-api/lib/utils/messages');
        this.conn.sendMessage(new pb.SubscribeBluetoothConnectionsFreeRequest());
      } catch (err) {
        this.log(`ESPHome ${this.host}: could not read free slots: ${err.message}`);
      }
    });
  }

  // Wait for this device's next connection response (the library's own helper
  // matches on message type only, so a response for another device would do)
  awaitConnectionResponse(address, timeoutMs) {
    return new Promise((resolve, reject) => {
      const onMsg = (msg) => {
        if (msg.address !== address) return;
        cleanup();
        resolve(msg);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timeout'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.conn.off('message.BluetoothDeviceConnectionResponse', onMsg);
      };
      this.conn.on('message.BluetoothDeviceConnectionResponse', onMsg);
    });
  }

  sendDeviceRequest(address, type) {
    const { pb } = require('@2colors/esphome-native-api/lib/utils/messages');
    this.conn.sendMessage(new pb.BluetoothDeviceRequest([address, pb.BluetoothDeviceRequestType[type]]));
  }

  async disconnectDevice(address) {
    const done = this.awaitConnectionResponse(address, DISCONNECT_TIMEOUT_MS).catch(() => {});
    try {
      this.sendDeviceRequest(address, 'BLUETOOTH_DEVICE_REQUEST_TYPE_DISCONNECT');
    } catch (err) {
      return;
    }
    await done;
  }

  // Connect the proxy to a BLE device. Frees a slot still held from an earlier
  // attempt first, and always releases the slot again when the attempt fails.
  async connectDevice(address) {
    if (this.slots && this.slots.allocated.includes(address)) {
      this.log(`Proxy ${this.host} still holds a connection to the lock, releasing it`);
      await this.disconnectDevice(address);
    } else if (this.slots && this.slots.free === 0) {
      throw new Error(`no free Bluetooth connection slots (${this.slots.limit} in use)`);
    }
    const response = this.awaitConnectionResponse(address, CONNECT_TIMEOUT_MS);
    this.sendDeviceRequest(address, 'BLUETOOTH_DEVICE_REQUEST_TYPE_CONNECT_V3_WITHOUT_CACHE');
    let res;
    try {
      res = await response;
    } catch (err) {
      this.disconnectDevice(address).catch(() => {});
      throw new Error(`lock did not answer via this proxy within ${CONNECT_TIMEOUT_MS / 1000} s (out of range?)`);
    }
    if (!res.connected) {
      this.disconnectDevice(address).catch(() => {});
      throw new Error(`could not connect to lock (error ${res.error})`);
    }
    return res;
  }

  async connect() {
    try {
      await this.connectOnce();
    } catch (err) {
      // Key filled in, but the device's API isn't encrypted: connect without it
      if (this.encrypted && /Expected 1 at the begin/i.test(err.message)) {
        this.log(`ESPHome ${this.host} doesn't use encryption, ignoring the configured key`);
        this.conn.reconnect = false;
        this.conn.disconnect();
        this.createConnection('');
        await this.connectOnce();
        return;
      }
      if (/Encryption expected/i.test(err.message)) {
        throw new Error(`${this.host} requires an API encryption key (api: encryption: key)`);
      }
      throw err;
    }
  }

  async connectOnce() {
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
    await this.proxy.run(() => this.proxy.connectDevice(this.address));
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
    await this.proxy.run(() => this.proxy.disconnectDevice(this.address)).catch(() => {});
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

/**
 * Proxies from the settings text: one per line (or comma separated),
 * "host[:port]" or "host[:port] key". Lines without a key use defaultKey.
 */
function parseProxies(text, defaultKey = '') {
  return String(text || '')
    .split(/[\n,;]+/)
    .map((line) => line.trim().split(/\s+/).filter(Boolean))
    .filter((parts) => parts.length > 0)
    .map(([host, key]) => ({ host, encryptionKey: key || defaultKey || '' }));
}

// Which proxy reached a lock last time, so it is tried first next time
const lastGood = new Map();

async function connectViaProxies({ proxies, mac, log }) {
  const preferred = lastGood.get(mac);
  const ordered = [...proxies].sort((a, b) => (b.host === preferred) - (a.host === preferred));
  const errors = [];
  for (const p of ordered) {
    try {
      const peripheral = await connectViaProxy({ ...p, mac, log });
      if (preferred !== p.host) log(`Connected via proxy ${p.host}`);
      lastGood.set(mac, p.host);
      return peripheral;
    } catch (err) {
      errors.push(`${p.host}: ${err.message}`);
    }
  }
  throw new Error(errors.join('; '));
}

// Scan through all proxies at once; per device keep the strongest signal
async function scanProxies({ proxies, durationMs, log }) {
  const results = await Promise.all(proxies.map(
    (p) => getProxy({ ...p, log }).scan(durationMs)
      .then((found) => found.map((a) => ({ ...a, proxy: p.host })))
      .catch((err) => {
        log(`Scan via ${p.host} failed: ${err.message}`);
        return [];
      }),
  ));
  const best = new Map();
  for (const a of results.flat()) {
    if (!best.has(a.address) || a.rssi > best.get(a.address).rssi) best.set(a.address, a);
  }
  return [...best.values()];
}

module.exports = {
  getProxy, releaseProxy, connectViaProxy, connectViaProxies, scanProxies, parseProxies, macToNumber, numberToMac,
};

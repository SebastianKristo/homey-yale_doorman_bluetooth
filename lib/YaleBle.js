'use strict';

/*
 * Local BLE protocol for Yale / August locks (Doorman L3, Linus, Assure 2, ...).
 * Port of the protocol used by yalexs-ble (Home Assistant) / augustpy.
 *
 * Two channels:
 *  - secure channel (bd4ac613/614): AES-128-ECB with the offline key, used for the handshake
 *  - session channel (bd4ac611/612): AES-128-CBC (chained, IV=0) with a negotiated session key
 * Every message is 18 bytes; the first 16 are encrypted, the last 2 are cleartext.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const SERVICE_UUID = 'fe24';
const WRITE_CHAR = 'bd4ac6110b4511e38ffd0800200c9a66';
const READ_CHAR = 'bd4ac6120b4511e38ffd0800200c9a66';
const SECURE_WRITE_CHAR = 'bd4ac6130b4511e38ffd0800200c9a66';
const SECURE_READ_CHAR = 'bd4ac6140b4511e38ffd0800200c9a66';

const LockStatus = {
  0x00: 'unknown',
  0x01: 'calibrating',
  0x02: 'unlocking',
  0x03: 'unlocked',
  0x04: 'locking',
  0x05: 'locked',
};

const StatusType = {
  LOCK: 0x02,
  BATTERY: 0x0f,
};

// Per-cell AA voltage -> percentage (from yalexs-ble)
const AA_VOLTAGE_TO_PERCENT = [
  [1.24, 0], [1.25, 5], [1.26, 10], [1.27, 15], [1.28, 20], [1.29, 25], [1.30, 27],
  [1.31, 28], [1.32, 30], [1.33, 35], [1.34, 40], [1.35, 45], [1.36, 50], [1.37, 55],
  [1.38, 60], [1.39, 65], [1.40, 70], [1.45, 75], [1.46, 80], [1.471, 85], [1.49, 90],
  [1.49075, 93], [1.547, 94], [1.548, 95], [1.549, 97], [1.55, 100],
];

const RESPONSE_TIMEOUT = 8000;

function voltageToPercent(cellVoltage) {
  let pos = AA_VOLTAGE_TO_PERCENT.findIndex(([v]) => v >= cellVoltage);
  if (pos === -1) pos = AA_VOLTAGE_TO_PERCENT.length;
  if (pos !== 0) pos -= 1;
  return AA_VOLTAGE_TO_PERCENT[pos][1];
}

function parseBattery(buf) {
  // The lock reports the sum of its 4 AA cells
  const voltage = buf.readUInt16LE(0x08) / 1000;
  return { voltage, percentage: voltageToPercent(voltage / 4) };
}

// Status poll answers carry the opcode in byte 1 and the status type in byte 4.
// Anything else is an unsolicited push and must not be taken as the answer.
function pollMatcher(type) {
  return (buf) => buf[0] === 0xbb && buf[1] === 0x02 && buf[4] === type;
}

function normUuid(uuid) {
  const u = String(uuid).toLowerCase().replace(/-/g, '');
  // 0000xxxx-0000-1000-8000-00805f9b34fb -> xxxx
  const m = u.match(/^0000([0-9a-f]{4})00001000800000805f9b34fb$/);
  return m ? m[1] : u;
}

function simpleChecksum(buf) {
  let cs = 0;
  for (let i = 0; i < 0x12; i++) cs = (cs + buf[i]) & 0xff;
  return (-cs) & 0xff;
}

function securityChecksum(buf) {
  const sum = buf.readUInt32LE(0) + buf.readUInt32LE(4) + buf.readUInt32LE(8);
  return (0 - sum) >>> 0;
}

class Channel {

  constructor({ secure, keyIndex, writeChar, log }) {
    this.secure = secure;
    this.keyIndex = keyIndex;
    this.writeChar = writeChar;
    this.log = log;
    this.encryptor = null;
    this.decryptor = null;
    this.pending = null;
    this.queue = Promise.resolve();
  }

  setKey(key) {
    const algo = this.secure ? 'aes-128-ecb' : 'aes-128-cbc';
    const iv = this.secure ? null : Buffer.alloc(16);
    // Ciphers are kept for the whole session: CBC state chains across messages
    this.encryptor = crypto.createCipheriv(algo, key, iv).setAutoPadding(false);
    this.decryptor = crypto.createDecipheriv(algo, key, iv).setAutoPadding(false);
  }

  buildCommand(opcode) {
    const cmd = Buffer.alloc(0x12);
    if (this.secure) {
      cmd[0x00] = opcode;
      cmd[0x10] = 0x0f;
      cmd[0x11] = this.keyIndex;
    } else {
      cmd[0x00] = 0xee;
      cmd[0x01] = opcode;
      cmd[0x10] = 0x02;
    }
    return cmd;
  }

  writeChecksum(cmd) {
    if (this.secure) cmd.writeUInt32LE(securityChecksum(cmd), 0x0c);
    else cmd[0x03] = simpleChecksum(cmd);
  }

  onData(data) {
    const buf = Buffer.from(data);
    if (this.decryptor && buf.length >= 16) {
      this.decryptor.update(buf.subarray(0, 16)).copy(buf, 0);
    }
    if (this.pending && (!this.pending.matcher || this.pending.matcher(buf))) {
      const { resolve } = this.pending;
      this.pending = null;
      resolve(buf);
    } else if (this.onUnsolicited) {
      this.onUnsolicited(buf);
    }
  }

  execute(cmd, matcher) {
    const run = async () => {
      this.writeChecksum(cmd);
      const out = Buffer.from(cmd);
      if (this.encryptor) this.encryptor.update(out.subarray(0, 16)).copy(out, 0);

      let timer;
      const response = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          this.pending = null;
          reject(new Error('Timeout waiting for lock response'));
        }, RESPONSE_TIMEOUT);
        this.pending = {
          matcher,
          resolve: (buf) => { clearTimeout(timer); resolve(buf); },
        };
      });

      try {
        await this.writeChar.write(out);
      } catch (err) {
        clearTimeout(timer);
        this.pending = null;
        throw err;
      }
      const res = await response;

      if (this.secure && securityChecksum(res) !== res.readUInt32LE(0x0c)) {
        throw new Error('Security checksum mismatch - wrong offline key or slot?');
      }
      return res;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

}

class YaleLock extends EventEmitter {

  /**
   * @param {object} opts
   * @param {import('homey')} opts.homey
   * @param {string} opts.peripheralUuid Homey BLE peripheral uuid
   * @param {string} opts.key offline key (32 hex chars)
   * @param {number} opts.slot offline key slot / index
   */
  constructor({ homey, peripheralUuid, key, slot, log }) {
    super();
    this.homey = homey;
    this.peripheralUuid = peripheralUuid;
    this.key = Buffer.from(String(key).trim(), 'hex');
    if (this.key.length !== 16) throw new Error('Offline key must be 32 hex characters');
    this.slot = Number(slot);
    this.log = log || (() => {});
    this.peripheral = null;
    this.session = null;
    this.secureSession = null;
    this.connecting = null;
  }

  get connected() {
    return !!(this.peripheral && this.session);
  }

  async connect() {
    if (this.connected) return;
    if (!this.connecting) {
      this.connecting = this._connect().finally(() => { this.connecting = null; });
    }
    await this.connecting;
  }

  async _connect() {
    const advertisement = await this.homey.ble.find(this.peripheralUuid);
    const peripheral = await advertisement.connect();
    // Homey may hand back the same peripheral object on reconnect, so the
    // listener is removed again in _reset() instead of piling up
    const onDisconnect = () => {
      this.log('Disconnected');
      this._reset();
    };
    peripheral.once('disconnect', onDisconnect);
    try {

      await peripheral.discoverAllServicesAndCharacteristics();
      const services = peripheral.services || [];
      const service = services.find((s) => normUuid(s.uuid) === SERVICE_UUID);
      if (!service) throw new Error('Yale BLE service not found on device');

      const chars = {};
      for (const c of service.characteristics || []) chars[normUuid(c.uuid)] = c;
      for (const u of [WRITE_CHAR, READ_CHAR, SECURE_WRITE_CHAR, SECURE_READ_CHAR]) {
        if (!chars[u]) throw new Error(`Characteristic ${u} not found`);
      }

      const session = new Channel({ secure: false, writeChar: chars[WRITE_CHAR], log: this.log });
      const secureSession = new Channel({
        secure: true, keyIndex: this.slot, writeChar: chars[SECURE_WRITE_CHAR], log: this.log,
      });
      session.onUnsolicited = (buf) => this._onUnsolicited(buf);

      // Order matters (as in yalexs-ble): the lock rejects notifications on the
      // session channel (ATT error 0x0E) until the secure handshake is done
      await chars[SECURE_READ_CHAR].subscribeToNotifications((data) => secureSession.onData(data));

      secureSession.setKey(this.key);

      // Key exchange
      const handshakeKeys = crypto.randomBytes(16);
      let cmd = secureSession.buildCommand(0x01);
      handshakeKeys.copy(cmd, 0x04, 0x00, 0x08);
      let res = await secureSession.execute(cmd);
      if (res[0] !== 0x02) throw new Error(`Unexpected handshake response 0x${res[0].toString(16)}`);

      const sessionKey = Buffer.alloc(16);
      handshakeKeys.copy(sessionKey, 0, 0x00, 0x08);
      res.copy(sessionKey, 0x08, 0x04, 0x0c);
      session.setKey(sessionKey);

      // Initialization
      cmd = secureSession.buildCommand(0x03);
      handshakeKeys.copy(cmd, 0x04, 0x08, 0x10);
      res = await secureSession.execute(cmd);
      if (res[0] !== 0x04) throw new Error(`Unexpected init response 0x${res[0].toString(16)}`);

      await chars[READ_CHAR].subscribeToNotifications((data) => session.onData(data));

      this.peripheral = peripheral;
      this.onDisconnect = onDisconnect;
      this.session = session;
      this.secureSession = secureSession;
      this.log('Connected and authenticated');
    } catch (err) {
      peripheral.removeListener('disconnect', onDisconnect);
      await peripheral.disconnect().catch(() => {});
      throw err;
    }
  }

  _reset() {
    if (this.peripheral && this.onDisconnect) {
      this.peripheral.removeListener('disconnect', this.onDisconnect);
    }
    this.onDisconnect = null;
    this.peripheral = null;
    this.session = null;
    this.secureSession = null;
  }

  _onUnsolicited(buf) {
    // Lock pushes status updates on the session channel while connected
    if (pollMatcher(StatusType.LOCK)(buf)) {
      this.emit('status', LockStatus[buf[8]] || 'unknown');
    } else if (pollMatcher(StatusType.BATTERY)(buf)) {
      this.emit('battery', parseBattery(buf));
    }
  }

  async disconnect() {
    const { peripheral, secureSession } = this;
    if (!peripheral) return;
    try {
      if (secureSession) {
        const cmd = secureSession.buildCommand(0x05);
        cmd[0x11] = 0x00;
        await secureSession.execute(cmd).catch(() => {});
      }
    } finally {
      this._reset();
      await peripheral.disconnect().catch(() => {});
    }
  }

  async status() {
    await this.connect();
    const cmd = this.session.buildCommand(0x02);
    cmd[0x04] = StatusType.LOCK;
    const res = await this.session.execute(cmd, pollMatcher(StatusType.LOCK));
    return LockStatus[res[0x08]] || 'unknown';
  }

  /** @returns {Promise<{voltage: number, percentage: number}>} */
  async battery() {
    await this.connect();
    const cmd = this.session.buildCommand(0x02);
    cmd[0x04] = StatusType.BATTERY;
    return parseBattery(await this.session.execute(cmd, pollMatcher(StatusType.BATTERY)));
  }

  async lock() {
    await this.connect();
    await this.session.execute(this.session.buildCommand(0x0b));
  }

  async unlock() {
    await this.connect();
    await this.session.execute(this.session.buildCommand(0x0a));
  }

}

module.exports = {
  YaleLock, SERVICE_UUID, normUuid, LockStatus, voltageToPercent,
};

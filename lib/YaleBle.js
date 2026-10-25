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
  0x07: 'jammed',
  0x09: 'unlocking', // unlatching
  0x0a: 'unlocked', // unlatched
  0x0c: 'locked', // secure mode
};

const OP_RESULT_BYTE = 0x0f;
const CMD_UNLOCK = 0x0a;
const CMD_LOCK = 0x0b;

const StatusType = {
  LOCK: 0x02,
  DOOR_AND_LOCK: 0x2f,
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
const FRAME_LEN = 0x12;
const SECURE_ATTEMPTS = 3;

class ResponseError extends Error {}
// Minimum time between a response and the next command, "for lock to settle"
const COOLDOWN_MS = 250;

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

// Prefix BLE errors with the step that failed, so the message shown in the
// Homey app tells which operation the lock rejected
async function step(name, fn) {
  try {
    return await fn();
  } catch (err) {
    // New error: Homey's error objects may not allow changing the message
    throw new Error(`${name}: ${(err && err.message) || err}`);
  }
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

  constructor({ secure, keyIndex, writeChar, readChar, log }) {
    this.secure = secure;
    this.readChar = readChar;
    this.pollRead = false;
    this.keyIndex = keyIndex;
    this.writeChar = writeChar;
    this.log = log;
    this.encryptor = null;
    this.decryptor = null;
    this.pending = null;
    this.queue = Promise.resolve();
    this.cooldown = false;
    this.lastResponseAt = 0;
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
    const buf = Buffer.from(data || []);
    // Empty notifications are transport artifacts, not frames from the lock
    if (buf.length === 0) return;
    // Only whole 18-byte frames may reach the cipher: a partial block would
    // desynchronise the CBC chain for the rest of the connection
    if (buf.length !== FRAME_LEN) {
      this.log(`Dropping ${buf.length}-byte notification on ${this.secure ? 'secure' : 'session'} channel`);
      return;
    }
    if (this.decryptor) this.decryptor.update(buf.subarray(0, 16)).copy(buf, 0);
    this.lastResponseAt = Date.now();

    if (this.secure && securityChecksum(buf) !== buf.readUInt32LE(0x0c)) {
      const info = `op=0x${buf[0].toString(16).padStart(2, '0')}`;
      this.log(`Invalid secure frame (${info})`);
      if (this.pending) {
        const { reject } = this.pending;
        this.pending = null;
        reject(new ResponseError(`Security checksum mismatch (${info})`));
      }
      return;
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
    const attempt = async () => {
      const wait = this.lastResponseAt + COOLDOWN_MS - Date.now();
      if (this.cooldown && wait > 0) await new Promise((r) => setTimeout(r, wait));
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
          reject: (err) => { clearTimeout(timer); reject(err); },
        };
      });

      try {
        await step(this.secure ? 'write secure' : 'write', () => this.writeChar.write(out));
        // Without notifications, read the response characteristic directly
        if (this.pollRead) this.onData(await step('read response', () => this.readChar.read()));
      } catch (err) {
        clearTimeout(timer);
        this.pending = null;
        throw err;
      }
      return response;
    };

    // Like yalexs-ble, resend on an invalid response. Only on the secure
    // channel: it is ECB, so a resend doesn't disturb any cipher state
    const run = async () => {
      for (let i = 1; ; i++) {
        try {
          return await attempt();
        } catch (err) {
          if (!(err instanceof ResponseError) || !this.secure || i >= SECURE_ATTEMPTS) throw err;
          this.log(`${err.message}, retrying (${i}/${SECURE_ATTEMPTS})`);
        }
      }
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
  constructor({
    homey, peripheralUuid, key, slot, log, openPeripheral,
  }) {
    super();
    // Optional replacement for Homey's own radio, e.g. an ESPHome proxy
    this.openPeripheral = openPeripheral;
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
    let peripheral;
    if (this.openPeripheral) {
      peripheral = await step('proxy', () => this.openPeripheral());
    } else {
      const advertisement = await step('find', () => this.homey.ble.find(this.peripheralUuid));
      peripheral = await step('connect', () => advertisement.connect());
    }
    // Homey may hand back the same peripheral object on reconnect, so the
    // listener is removed again in _reset() instead of piling up
    const onDisconnect = () => {
      this.log('Disconnected');
      this._reset();
      // Only for drops we didn't ask for; disconnect() removes this listener first
      this.emit('disconnected');
    };
    peripheral.once('disconnect', onDisconnect);
    try {

      // Only discover the Yale service. Discovering everything also touches the
      // lock's HomeKit service, which requires its own encryption and fails
      let services = await step('discover services', () => peripheral.discoverServices([SERVICE_UUID]))
        .catch(() => step('discover services', () => peripheral.discoverServices()));
      let service = (services || []).find((s) => normUuid(s.uuid) === SERVICE_UUID);
      if (!service) {
        services = await step('discover services', () => peripheral.discoverServices());
        service = (services || []).find((s) => normUuid(s.uuid) === SERVICE_UUID);
      }
      if (!service) throw new Error('Yale BLE service not found on device');

      const characteristics = await step('discover characteristics', () => service.discoverCharacteristics());
      const chars = {};
      for (const c of characteristics || service.characteristics || []) chars[normUuid(c.uuid)] = c;
      for (const u of [WRITE_CHAR, READ_CHAR, SECURE_WRITE_CHAR, SECURE_READ_CHAR]) {
        if (!chars[u]) throw new Error(`Characteristic ${u} not found`);
      }

      const session = new Channel({
        secure: false, writeChar: chars[WRITE_CHAR], readChar: chars[READ_CHAR], log: this.log,
      });
      const secureSession = new Channel({
        secure: true,
        keyIndex: this.slot,
        writeChar: chars[SECURE_WRITE_CHAR],
        readChar: chars[SECURE_READ_CHAR],
        log: this.log,
      });
      session.onUnsolicited = (buf) => this._onUnsolicited(buf);

      // Order matters (as in yalexs-ble): the lock rejects notifications on the
      // session channel (ATT error 0x0E) until the secure handshake is done
      await this._subscribe(secureSession, 'notify secure');

      secureSession.setKey(this.key);

      // Key exchange
      const handshakeKeys = crypto.randomBytes(16);
      let cmd = secureSession.buildCommand(0x01);
      handshakeKeys.copy(cmd, 0x04, 0x00, 0x08);
      let res = await step('handshake', () => secureSession.execute(cmd));
      if (res[0] !== 0x02) throw new Error(`Unexpected handshake response 0x${res[0].toString(16)}`);

      const sessionKey = Buffer.alloc(16);
      handshakeKeys.copy(sessionKey, 0, 0x00, 0x08);
      res.copy(sessionKey, 0x08, 0x04, 0x0c);
      // The rest of the secure exchange is encrypted with the session key
      secureSession.setKey(sessionKey);

      // Initialization
      cmd = secureSession.buildCommand(0x03);
      handshakeKeys.copy(cmd, 0x04, 0x08, 0x10);
      res = await step('init', () => secureSession.execute(cmd));
      if (res[0] !== 0x04) throw new Error(`Unexpected init response 0x${res[0].toString(16)}`);
      session.setKey(sessionKey);
      session.cooldown = true;
      secureSession.cooldown = true;

      await this._subscribe(session, 'notify');

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

  async _subscribe(channel, name) {
    try {
      await channel.readChar.subscribeToNotifications((data) => channel.onData(data));
    } catch (err) {
      // Fall back to reading responses, but don't hide why
      this.log(`${name} failed (${err.message}), falling back to reads`);
      channel.pollRead = true;
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
    // Frames the lock pushes on its own while connected (as parsed by yalexs-ble)
    if (pollMatcher(StatusType.LOCK)(buf) || pollMatcher(StatusType.DOOR_AND_LOCK)(buf)) {
      this.emit('status', LockStatus[buf[8]] || 'unknown');
    } else if (pollMatcher(StatusType.BATTERY)(buf)) {
      this.emit('battery', parseBattery(buf));
    } else if (buf[0] === 0xbb && (buf[1] === CMD_LOCK || buf[1] === CMD_UNLOCK)) {
      // Sent when the motor stops after lock/unlock; non-zero result = stalled/jammed
      if (buf[OP_RESULT_BYTE] !== 0) this.emit('status', 'jammed');
      else this.emit('status', buf[1] === CMD_LOCK ? 'locked' : 'unlocked');
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

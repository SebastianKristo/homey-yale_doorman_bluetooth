'use strict';

const crypto = require('crypto');
const Homey = require('homey');
const { parseUnifiEvent } = require('./lib/unifi');

const METHODS = ['face', 'fingerprint', 'nfc', 'pin', 'other'];
// UniFi often sends several events for one recognition; unlock once
const RULE_COOLDOWN_MS = 10 * 1000;

function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// "Sebastian" matches "Sebastian Kristo" and vice versa, case-insensitive
function samePerson(a, b) {
  const x = String(a || '').trim().toLowerCase();
  const y = String(b || '').trim().toLowerCase();
  return x === y || (x && y && (x.startsWith(`${y} `) || y.startsWith(`${x} `)));
}

class YaleBleApp extends Homey.App {

  async onInit() {
    if (!this.homey.settings.get('webhook_token')) this.regenerateWebhookToken();
    this.unifiTrigger = this.homey.flow.getTriggerCard('unifi_event');
    this.lastRuleRun = new Map();
    this.log('Yale Local Bluetooth started');
  }

  // --- General webhook (Flow only)

  regenerateWebhookToken() {
    this.homey.settings.set('webhook_token', crypto.randomBytes(24).toString('hex'));
    // Keep the URL shown in the lock settings in sync
    // On first start the driver isn't ready yet; devices show the URL on init then
    try {
      this.getLocks().forEach((d) => d.showWebhookUrl().catch(this.error));
    } catch (err) {
      // Driver not initialised yet
    }
  }

  async baseUrl() {
    const address = await this.homey.cloud.getLocalAddress().catch(() => null);
    const host = address ? address.replace(/:80$/, '') : '<homey-ip>';
    return `http://${host}/api/app/${this.homey.manifest.id}/unifi`;
  }

  async getWebhookInfo() {
    return {
      url: `${await this.baseUrl()}?token=${this.homey.settings.get('webhook_token')}`,
      lastEvent: this.homey.settings.get('webhook_last_event') || null,
    };
  }

  // --- Unlock rules: one webhook URL per person + method + lock

  getLocks() {
    return this.homey.drivers.getDriver('lock').getDevices();
  }

  findLock(id) {
    return this.getLocks().find((d) => d.getData().id === id);
  }

  getRules() {
    return this.homey.settings.get('unifi_rules') || [];
  }

  saveRules(rules) {
    this.homey.settings.set('unifi_rules', rules);
  }

  async listRules() {
    const base = await this.baseUrl();
    const locks = this.getLocks().map((d) => ({ id: d.getData().id, name: d.getName() }));
    return {
      locks,
      rules: this.getRules().map(({ token, ...rule }) => ({
        ...rule,
        url: `${base}?token=${token}`,
        lockName: (locks.find((l) => l.id === rule.deviceId) || {}).name || '?',
      })),
      lastEvent: this.homey.settings.get('webhook_last_event') || null,
    };
  }

  validateRule({ person, method, deviceId }) {
    if (!String(person || '').trim()) throw new Error(this.homey.__('settings.err_person'));
    if (!METHODS.includes(method)) throw new Error(this.homey.__('settings.err_method'));
    if (!this.findLock(deviceId)) throw new Error(this.homey.__('settings.err_lock'));
  }

  async createRule(input) {
    this.validateRule(input);
    const rules = this.getRules();
    rules.push({
      id: crypto.randomBytes(6).toString('hex'),
      token: crypto.randomBytes(24).toString('hex'),
      person: String(input.person).trim(),
      method: input.method,
      deviceId: input.deviceId,
      enabled: true,
    });
    this.saveRules(rules);
    return this.listRules();
  }

  async updateRule(id, patch) {
    const rules = this.getRules();
    const rule = rules.find((r) => r.id === id);
    if (!rule) throw new Error('Not found');
    if (typeof patch.enabled === 'boolean') rule.enabled = patch.enabled;
    this.saveRules(rules);
    return this.listRules();
  }

  async deleteRule(id) {
    this.saveRules(this.getRules().filter((r) => r.id !== id));
    return this.listRules();
  }

  // Decide whether a rule's webhook may unlock; returns the reason if not
  ruleBlocker(rule, payloadEvent) {
    if (!rule.enabled) return 'disabled';
    if (payloadEvent.result && payloadEvent.result.toUpperCase() !== 'ACCESS') return `result ${payloadEvent.result}`;
    // UniFi named someone else: never unlock for the wrong person
    if (payloadEvent.person && !samePerson(payloadEvent.person, rule.person)) return `person "${payloadEvent.person}"`;
    const last = this.lastRuleRun.get(rule.id) || 0;
    if (Date.now() - last < RULE_COOLDOWN_MS) return 'repeat';
    return null;
  }

  async runRule(rule, payloadEvent) {
    const blocker = this.ruleBlocker(rule, payloadEvent);
    if (blocker) return `ignored (${blocker})`;
    const device = this.findLock(rule.deviceId);
    if (!device) return 'ignored (lock missing)';
    this.lastRuleRun.set(rule.id, Date.now());
    // Answer UniFi right away; the unlock itself can take a few seconds
    device.unlockFor(rule.person, rule.method)
      .then(() => this.storeOutcome('unlocked'))
      .catch((err) => {
        this.error('Rule unlock failed', err.message);
        this.storeOutcome(`failed: ${err.message}`);
      });
    return 'unlocking';
  }

  storeOutcome(outcome) {
    const last = this.homey.settings.get('webhook_last_event');
    if (last) this.homey.settings.set('webhook_last_event', { ...last, outcome });
  }

  async onUnifiWebhook({ query = {}, body = {} }) {
    const rule = this.getRules().find((r) => sameToken(query.token, r.token));
    if (!rule && !sameToken(query.token, this.homey.settings.get('webhook_token'))) {
      this.log('Rejected UniFi webhook with invalid token');
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      throw err;
    }

    const payloadEvent = parseUnifiEvent(body || {}, {});
    // A rule decides who and how; otherwise URL parameters, then the payload
    const event = rule
      ? { ...payloadEvent, person: rule.person, type: rule.method, result: payloadEvent.result || 'ACCESS' }
      : parseUnifiEvent(body || {}, query);

    const outcome = rule ? await this.runRule(rule, payloadEvent) : 'flow';
    this.log(`UniFi event: alarm="${event.alarm}" person="${event.person}" type=${event.type} -> ${outcome}`);
    this.homey.settings.set('webhook_last_event', { ...event, outcome, at: new Date().toISOString() });
    await this.unifiTrigger.trigger(event).catch(this.error);
    return { ok: true, outcome };
  }

}

module.exports = YaleBleApp;

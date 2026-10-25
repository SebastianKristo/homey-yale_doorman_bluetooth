'use strict';

const crypto = require('crypto');
const Homey = require('homey');
const { parseUnifiEvent } = require('./lib/unifi');

class YaleBleApp extends Homey.App {

  async onInit() {
    if (!this.homey.settings.get('webhook_token')) this.regenerateWebhookToken();
    this.unifiTrigger = this.homey.flow.getTriggerCard('unifi_event');
    this.log('Yale Local Bluetooth started');
  }

  regenerateWebhookToken() {
    this.homey.settings.set('webhook_token', crypto.randomBytes(24).toString('hex'));
    // Keep the URL shown in the lock settings in sync
    // On first start the driver isn't ready yet; devices show the URL on init then
    try {
      this.homey.drivers.getDriver('lock').getDevices()
        .forEach((d) => d.showWebhookUrl().catch(this.error));
    } catch (err) {
      // Driver not initialised yet
    }
  }

  async getWebhookInfo() {
    const token = this.homey.settings.get('webhook_token');
    // Base URL; the settings page appends &person=…&method=… per alarm
    const address = await this.homey.cloud.getLocalAddress().catch(() => null);
    const host = address ? address.replace(/:80$/, '') : '<homey-ip>';
    return {
      url: `http://${host}/api/app/${this.homey.manifest.id}/unifi?token=${token}`,
      lastEvent: this.homey.settings.get('webhook_last_event') || null,
    };
  }

  // Constant-time compare so the token can't be guessed by timing
  isValidToken(token) {
    const expected = Buffer.from(String(this.homey.settings.get('webhook_token') || ''));
    const given = Buffer.from(String(token || ''));
    return expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  async onUnifiWebhook({ query = {}, body = {} }) {
    if (!this.isValidToken(query.token)) {
      this.log('Rejected UniFi webhook with invalid token');
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      throw err;
    }
    // GET requests (and quick tests) can carry the fields as query parameters
    const event = parseUnifiEvent(body || {}, query);
    this.log(`UniFi event: alarm="${event.alarm}" person="${event.person}" type=${event.type} (${event.rawType})`);
    this.homey.settings.set('webhook_last_event', { ...event, at: new Date().toISOString() });
    await this.unifiTrigger.trigger(event);
    return { ok: true };
  }

}

module.exports = YaleBleApp;

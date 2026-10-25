'use strict';

module.exports = {
  // Public: called by UniFi; protected by the secret token in the URL
  async unifiPost({ homey, query, body }) {
    return homey.app.onUnifiWebhook({ query, body });
  },
  async unifiGet({ homey, query }) {
    return homey.app.onUnifiWebhook({ query, body: {} });
  },
  // Used by the app settings page (requires Homey login)
  async webhookInfo({ homey }) {
    return homey.app.getWebhookInfo();
  },
  async regenerateToken({ homey }) {
    homey.app.regenerateWebhookToken();
    return homey.app.getWebhookInfo();
  },
};

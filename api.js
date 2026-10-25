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
  async listRules({ homey }) {
    return homey.app.listRules();
  },
  async createRule({ homey, body }) {
    return homey.app.createRule(body || {});
  },
  async updateRule({ homey, params, body }) {
    return homey.app.updateRule(params.id, body || {});
  },
  async deleteRule({ homey, params }) {
    return homey.app.deleteRule(params.id);
  },
};

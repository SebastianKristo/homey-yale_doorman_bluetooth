'use strict';

module.exports = {
  // Public: called by UniFi; protected by the secret key in the URL
  // The key is in the path: Homey treats a ?token= query parameter as its own
  // login token and rejects the request before it reaches the app
  async unifiPost({ homey, params, query, body }) {
    return homey.app.onUnifiWebhook({ key: params.key, query, body });
  },
  async unifiGet({ homey, params, query }) {
    return homey.app.onUnifiWebhook({ key: params.key, query, body: {} });
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

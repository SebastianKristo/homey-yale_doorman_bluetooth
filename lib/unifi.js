'use strict';

/*
 * Parse webhooks from UniFi Protect Alarm Manager and UniFi Access into one
 * flat event. The payload formats differ between products and versions, so
 * fields are looked up defensively and the raw trigger key is kept.
 */

function normaliseType(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('face')) return 'face';
  if (s.includes('finger')) return 'fingerprint';
  if (s.includes('nfc') || s.includes('card')) return 'nfc';
  if (s.includes('pin')) return 'pin';
  if (s.includes('plate') || s.includes('license')) return 'license_plate';
  return s || 'unknown';
}

function first(...values) {
  return values.find((v) => typeof v === 'string' && v.trim() !== '') || '';
}

function parseUnifiEvent(body = {}) {
  const alarm = body.alarm || {};
  const triggers = Array.isArray(alarm.triggers) ? alarm.triggers : [];
  const trigger = triggers.find((t) => t && t.value) || triggers[0] || {};

  // UniFi Access webhooks (e.g. access.door.unlock)
  const data = body.data || {};
  const actor = data.actor || body.actor || {};
  const object = data.object || {};
  const location = data.location || {};

  const rawType = first(trigger.key, object.authentication_type, object.auth_type, body.event, body.type);

  return {
    alarm: first(alarm.name, body.event, body.name),
    person: first(trigger.value, actor.display_name, actor.name, object.user_name, body.person),
    type: normaliseType(rawType),
    rawType,
    device: first(trigger.device, (data.device || {}).name, location.name, object.device_name, body.device),
    // UniFi Access also reports denied attempts; Protect alarms only fire on a match
    result: first(object.result, data.result, body.result) || (triggers.length ? 'ACCESS' : ''),
  };
}

module.exports = { parseUnifiEvent, normaliseType };

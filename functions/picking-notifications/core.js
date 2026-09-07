'use strict';

const { createHash } = require('node:crypto');
const PROJECT = 'tabellone-produzione-liv-e313e';
const REGION = 'europe-west1';
const URL = 'https://' + PROJECT + '.web.app/picking.html';
const PREFIX = 'picking_email_';
const KIND = 'picking_new_work_v1';
const OWNER_EMAILS = new Set(['ludovico@generalcoppersrl.com', 'ludovicogiarola@gmail.com']);
const clean = (value, max = 180) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const email = value => clean(value, 254).toLowerCase();
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const validEmail = value => /^[^\s<>,;@]+@[^\s<>,;@]+\.[^\s<>,;@]+$/.test(String(value || ''));
const millis = value => {
  if (value?.toMillis) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  return value ? (Date.parse(value) || 0) : 0;
};
const number = value => {
  if (typeof value === 'string') value = value.replace(/\s/g, '').replace(',', '.');
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
};
const isEnabled = data => !!data && data.enabled !== false && data.disabled !== true;
// Only isAdmin is constrained by the existing powderUsers self-write rules.
// Profile aliases such as role/admin are not an authorization source.
const hasAdminRole = data => isEnabled(data) && data.isAdmin === true;

function accessFor(user, directory) {
  if (!user || user.disabled || !validEmail(user.email)) return { member: false, admin: false };
  const mail = email(user.email);
  const docs = directory.filter(row => row.id === user.uid || row.id === mail);
  // A disabled UID is authoritative even if an older email invitation still exists.
  if (docs.some(row => row.id === user.uid && !isEnabled(row.data))) return { member: false, admin: false };
  const owner = user.emailVerified === true && OWNER_EMAILS.has(mail);
  return {
    member: owner || docs.some(row => isEnabled(row.data)),
    admin: owner || docs.some(row => hasAdminRole(row.data)),
  };
}

function isFba(data) {
  if (!data) return false;
  if (['fba', 'isFba', 'isFBA', 'amazonFba', 'fulfillmentByAmazon'].some(k => data[k] === true)) return true;
  const w = data.workflow || {}, p = data.picking || {}, r = data.reservation || {}, s = data.shopify || {};
  const values = [data.id, data.workflowId, data.workflowLabel, w.id, w.label, data.fileName,
    data.source, data.channel, data.fulfillmentChannel, data.fulfillment_channel,
    data.fulfillmentService, data.fulfillmentType, data.shipmentId, data.shipmentCode,
    data.fbaShipmentId, data.inboundShipmentId, data.orderId, r.source, r.channel,
    p.source, p.channel, s.fulfillmentChannel, data.tags, data.tag, p.tags, r.tags, s.tags,
    ...(Array.isArray(w.shipments) ? w.shipments.flatMap(x => [x.code, x.id, x.shipmentId]) : [])];
  return /(^|[^a-z0-9])fba([^a-z]|$)|\bfba[0-9a-z]{5,}\b|amazon[_ -]?fulfilled|fulfilled[_ -]?by[_ -]?amazon|amazon[_ -]?fba/i.test(values.flat(3).join(' '));
}

function isFbmFlow(data) {
  if (!data || isFba(data)) return false;
  const p = data.picking || {}, r = data.reservation || {}, s = data.shopify || {};
  const value = [data.source, s.source, r.source, data.fileName, data.workflowId,
    data.workflowLabel, data.channel, data.fulfillmentChannel, data.tags, s.tags, r.tags, p.tags].flat(3).join(' ');
  return /shopify[_ -]?fbm|merchant[_ -]?fulfilled|fulfilled[_ -]?by[_ -]?merchant|manual[_ -]?shopify|shopify-|\bfbm\b/i.test(value) ||
    p.shopifyControlled === true || data.shopifyControlled === true || data.generatedFromShopifyFbm === true;
}

function summarizeFba(data, id) {
  if (!data || data.voided || data.cancelled || data.canceled ||
      String(data.kind || '').toLowerCase() !== 'scarica' || isFbmFlow(data)) return null;
  const p = data.picking || {}, r = data.reservation || {};
  const status = String(data.status || p.status || '').toUpperCase();
  if (['PICKED', 'CANCELLED', 'CANCELED', 'VOIDED', 'COMPLETED'].includes(status) || p.flowPicked === true) return null;
  if (!(p.managedByPicking === true || r.active === true || ['RESERVED', 'PARTIAL_PICKED'].includes(status))) return null;
  const picked = p.pickedLines || {};
  const lines = (Array.isArray(data.lines) ? data.lines : []).filter(line => {
    const sku = clean(line?.sku);
    const mark = picked[sku] || {};
    return sku && number(line.qty) > 0 && mark.picked !== true && mark.status !== 'prelevato';
  });
  if (!lines.length) return null;
  return {
    channel: 'FBA', key: 'FBA:' + id, label: clean(data.workflowLabel || data.workflow?.label || data.fileName || id, 140),
    lines: lines.map(line => ({ sku: clean(line.sku), qty: number(line.qty) })),
    businessCreatedAt: millis(data.appliedAtClient || data.createdAtClient || data.createdAt),
  };
}

function summarizeFbm(data, id) {
  if (!data || data.active !== true || data.cancelled || data.canceled || data.cancelledAt || data.canceledAt || data.voided) return null;
  if (String(data.fulfillmentStatus || data.fulfillment_status || '').toLowerCase() === 'fulfilled') return null;
  const lines = Object.values(data.linesByLineId || {}).map(line => ({
    sku: clean(line?.sku),
    qty: Math.max(0, number(line?.reservedQty) - number(line?.shippedQty)),
  })).filter(line => line.sku && line.qty > 0);
  if (!lines.length) return null;
  return {
    channel: 'FBM', key: 'FBM:' + clean(data.orderId || id).replace(/^gid:\/\/shopify\/Order\//, ''),
    label: clean(data.orderName || data.orderId || id, 140), lines,
    businessCreatedAt: millis(data.shopifyCreatedAtClient || data.createdAtClient || data.createdAt),
  };
}

function newWork(before, after, id, channel, occurredAt, activatedAt, sourceCreatedAt) {
  const summarize = channel === 'FBA' ? summarizeFba : summarizeFbm;
  const work = summarize(after, id);
  if (!work || summarize(before, id)) return null;
  if (!activatedAt || occurredAt < activatedAt || sourceCreatedAt < activatedAt) return null;
  if (work.businessCreatedAt && work.businessCreatedAt < activatedAt) return null;
  return work;
}

function selectedForEvent(recipient, user, directory, occurredAt) {
  return recipient?.enabled === true && millis(recipient.enabledAt) <= occurredAt &&
    millis(recipient.enabledAt) > 0 && accessFor(user, directory).member &&
    user.emailVerified === true && email(user.email) === recipient.email;
}

function buildMessage(work) {
  const pieces = work.lines.reduce((total, line) => total + line.qty, 0);
  const skus = new Set(work.lines.map(line => line.sku)).size;
  const title = 'Picking ' + work.channel + ' · ' + work.label;
  const link = URL + '?picking=' + work.channel.toLowerCase();
  const text = ['È disponibile un nuovo ' + (work.channel === 'FBM' ? 'ordine FBM' : 'flusso FBA') + ' da preparare.',
    '', work.label, skus + ' SKU · ' + pieces + ' pezzi', '', 'Apri Picking: ' + link].join('\n');
  return { subject: title, text };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function envelopeHash(mail) {
  // Firestore may return map keys in a different order than the original write.
  return hash(JSON.stringify(canonical({ to: mail.to, from: mail.from, replyTo: mail.replyTo, message: mail.message,
    kind: mail.kind, picking: mail.picking })));
}

function deliveryOutcome(delivery, recipientEmail) {
  const state = String(delivery?.state || 'PENDING').toUpperCase();
  if (state === 'ERROR' && !retryDelay(delivery) &&
      /ETIMEDOUT|ECONNRESET|socket hang up|timeout|deadline/i.test(String(delivery.error || ''))) return 'UNKNOWN';
  if (state === 'SUCCESS') {
    const accepted = delivery?.info?.accepted || [];
    return accepted.some(value => email(typeof value === 'object' ? value.address : value) === email(recipientEmail))
      ? 'SUCCESS' : 'UNKNOWN';
  }
  if (['PENDING', 'PROCESSING', 'RETRY', 'ERROR'].includes(state)) return state;
  return 'UNKNOWN';
}

function retryDelay(delivery) {
  if (delivery?.state !== 'ERROR') return 0;
  const attempts = Math.max(1, number(delivery.attempts));
  if (attempts >= 3) return 0;
  const error = String(delivery.error || '');
  // Only explicit temporary SMTP rejection / pre-connection failure is safe to retry.
  // A timeout after DATA may already have sent the email; never retry it blindly.
  if (!/\b4(?:21|50|51|52)\b|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(error)) return 0;
  return attempts === 1 ? 60 : 300;
}

module.exports = { PROJECT, REGION, URL, PREFIX, KIND, clean, email, hash, validEmail, millis, number,
  isEnabled, accessFor, summarizeFba, summarizeFbm, newWork, selectedForEvent, buildMessage,
  envelopeHash, deliveryOutcome, retryDelay };

'use strict';

const { createHash } = require('node:crypto');
const { renderMessage } = require('./mail-template');
const PROJECT = 'tabellone-produzione-liv-e313e';
const REGION = 'europe-west1';
const URL = 'https://' + PROJECT + '.web.app/picking.html';
const PREFIX = 'picking_email_';
const KIND = 'picking_new_work_v1';
const TIME_ZONE = 'Europe/Rome';
const MAIL_FROM = 'LG Trading SRL - Picking Concamarise <info@generalcoppersrl.com>';
const OWNER_EMAILS = new Set(['ludovico@generalcoppersrl.com', 'ludovicogiarola@gmail.com']);
const clean = (value, max = 180) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const email = value => clean(value, 254).toLowerCase();
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const validEmail = value => /^[^\s<>,;@]+@[^\s<>,;@]+\.[^\s<>,;@]+$/.test(String(value || ''));
const skuKey = value => clean(value).replace(/\s+/g, ' ').toUpperCase();
const productTitle = value => clean(value, 600).split(/\s+(?:SKU\s*:|ASIN\s*:|Tipo di stoccaggio\b)/i)[0].trim();

function fbaReference(data) {
  const codes = [...new Set([data.shipmentCode, data.shipmentId, data.fbaShipmentId,
    ...(Array.isArray(data.workflow?.shipments) ? data.workflow.shipments.map(s => s.code || s.shipmentId || s.id) : [])]
    .map(value => clean(value, 80)).filter(Boolean))];
  if (codes.length) return codes.join(' / ');
  const label = clean(data.workflowLabel || data.workflow?.label || data.fileName, 140);
  // The worker needs the Amazon shipment reference, never an internal workflow UUID.
  return label && !/\bfluss[oi]\b|\bworkflow\b|^wf[0-9a-f-]+$/i.test(label) ? label : 'Preparazione FBA';
}
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
  if (!(p.managedByPicking === true || r.active === true ||
      ['RESERVED', 'PARTIAL_PICKED', 'PRENOTATO', 'IN_ATTESA_PICKING'].includes(status))) return null;
  const picked = p.pickedLines || {};
  const lines = (Array.isArray(data.lines) ? data.lines : []).filter(line => {
    const sku = clean(line?.sku);
    const key = sku.toUpperCase().replace(/[\/\\?#\[\]*\x00-\x1f\x7f]/g, '_').slice(0, 180);
    const mark = picked[key] || picked[sku] || {};
    return sku && number(line.qty) > 0 && mark.picked !== true && mark.status !== 'prelevato';
  });
  if (!lines.length) return null;
  return {
    channel: 'FBA', key: 'FBA:' + id, label: fbaReference(data),
    lines: lines.map(line => ({ sku: skuKey(line.sku), title: productTitle(line.title || line.productName || line.name), qty: number(line.qty) })),
    updatedAt: millis(data.updatedAtClient || data.updatedAt || data.appliedAtClient || data.appliedAt),
    businessCreatedAt: millis(data.appliedAtClient || data.createdAtClient || data.createdAt),
  };
}

function summarizeFbm(data, id) {
  if (!data || data.active !== true || data.cancelled || data.canceled || data.cancelledAt || data.canceledAt || data.voided) return null;
  if (String(data.fulfillmentStatus || data.fulfillment_status || '').toLowerCase() === 'fulfilled') return null;
  const stored = Object.values(data.linesByLineId || {});
  const details = Array.isArray(data.orderDetails?.lineItems) ? data.orderDetails.lineItems : [];
  const byId = new Map(details.map(line => [String(line.lineItemId || line.id || ''), line]));
  const bySku = new Map(details.map(line => [skuKey(line.sku), line]));
  const lines = stored.length ? stored.map(line => ({
    sku: skuKey(line?.sku),
    title: productTitle(line?.title || byId.get(String(line?.lineItemId || ''))?.title || bySku.get(skuKey(line?.sku))?.title),
    qty: Math.max(0, number(line?.reservedQty) - Math.max(number(line?.shippedQty), number(line?.inventoryAppliedQty))),
  })).filter(line => line.sku && line.qty > 0) :
    details
      .filter(line => line?.requiresShipping !== false && line?.giftCard !== true)
      .map(line => ({ sku: skuKey(line.sku), title: productTitle(line.title),
        qty: number(line.fulfillableQuantity ?? line.currentQuantity ?? line.quantity) }))
      .filter(line => line.sku && line.qty > 0);
  if (!lines.length) return null;
  return {
    channel: 'FBM', key: 'FBM:' + clean(data.orderId || id).replace(/^gid:\/\/shopify\/Order\//, ''),
    label: clean(data.orderName || data.orderId || id, 140).replace(/^#+/, '#'), lines,
    updatedAt: millis(data.shopifyUpdatedAtClient || data.updatedAtClient || data.updatedAt),
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

function pendingTotals(fbaDocs, fbmDocs) {
  const detail = pendingDetails(fbaDocs, fbmDocs);
  return { fba: detail.fba.orderCount, fbm: detail.fbm.orderCount };
}

function pendingDetails(fbaDocs, fbmDocs) {
  function group(docs, summarize) {
    const orders = new Map();
    for (const doc of [...docs].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      const work = summarize(doc.data, doc.id);
      if (!work) continue;
      const previous = orders.get(work.key);
      if (!previous || work.updatedAt > previous.updatedAt) orders.set(work.key, work);
    }
    const products = new Map();
    for (const work of orders.values()) for (const line of work.lines) {
      const sku = skuKey(line.sku);
      const product = products.get(sku) || { sku, title: '', qty: 0, references: new Map() };
      if (!product.title && line.title) product.title = line.title;
      product.qty += line.qty;
      const reference = product.references.get(work.key) || { label: work.label, qty: 0 };
      reference.qty += line.qty;
      product.references.set(work.key, reference);
      products.set(sku, product);
    }
    const rows = [...products.values()].map(p => ({ ...p, references: [...p.references.values()] }))
      .sort((a, b) => b.qty - a.qty || a.sku.localeCompare(b.sku));
    return { products: rows, totalQty: rows.reduce((n, p) => n + p.qty, 0),
      skuCount: rows.length, orderCount: orders.size };
  }
  return { fba: group(fbaDocs, summarizeFba), fbm: group(fbmDocs, summarizeFbm) };
}

function dailySlot(scheduleTime, now = Date.now()) {
  const time = millis(scheduleTime);
  if (!time || time > now + 60000 || now - time > 6 * 60 * 60 * 1000) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(time)).map(p => [p.type, p.value]));
  if (parts.hour !== '08' || parts.minute !== '00') return null;
  return { key: 'DAILY_FBM:' + parts.year + '-' + parts.month + '-' + parts.day, occurredAt: time };
}

function buildMessage(options) {
  return renderMessage({ ...options, url: URL, timeZone: TIME_ZONE });
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

module.exports = { PROJECT, REGION, URL, PREFIX, KIND, TIME_ZONE, MAIL_FROM, clean, skuKey, productTitle, email, hash, validEmail, millis, number,
  isEnabled, accessFor, summarizeFba, summarizeFbm, newWork, selectedForEvent, buildMessage,
  pendingTotals, pendingDetails, dailySlot, envelopeHash, deliveryOutcome, retryDelay };

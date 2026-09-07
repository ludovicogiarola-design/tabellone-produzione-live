'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('./core');
const fba = extra => ({ kind: 'scarica', status: 'RESERVED', fileName: 'FBA123456.pdf',
  picking: { managedByPicking: true }, lines: [{ sku: 'SKU-1', qty: 4 }], ...extra });
const fbm = extra => ({ active: true, orderId: '1234', orderName: '#1234',
  linesByLineId: { a: { sku: 'SKU-1', reservedQty: 3, shippedQty: 1 } }, ...extra });
const user = { uid: 'worker', email: 'worker@example.com', emailVerified: true };
const directory = [{ id: 'worker', data: { enabled: true } }];

test('FBA with old Shopify metadata remains FBA; FBM logs are excluded', () => {
  assert.equal(c.summarizeFba(fba({ source: 'shopify_fbm' }), 'flow').channel, 'FBA');
  assert.equal(c.summarizeFba(fba({ source: 'shopify_fbm', fileName: 'SHOPIFY_FBM' }), 'flow'), null);
});
test('Completed, cancelled, and empty work never creates alerts', () => {
  for (const patch of [{ voided: true }, { status: 'PICKED' }, { lines: [] },
    { picking: { managedByPicking: true, flowPicked: true } }]) {
    assert.equal(c.summarizeFba(fba(patch), 'f'), null);
  }
  for (const patch of [{ active: false }, { cancelled: true }, { linesByLineId: {} },
    { linesByLineId: { a: { sku: 'S', reservedQty: -3, shippedQty: 0 } } }]) {
    assert.equal(c.summarizeFbm(fbm(patch), 'o'), null);
  }
});
test('Only transition into pending work alerts; resyncs and old imports do not', () => {
  assert.equal(c.newWork(null, fbm(), '1234', 'FBM', 200, 100, 150)?.channel, 'FBM');
  assert.equal(c.newWork(fbm(), fbm({ updatedAtClient: 300 }), '1234', 'FBM', 300, 100, 150), null);
  assert.equal(c.newWork(null, fbm({ shopifyCreatedAtClient: 50 }), '1234', 'FBM', 300, 100, 150), null);
  assert.equal(c.newWork(null, fba(), 'f', 'FBA', 200, 100, 50), null);
  assert.equal(c.newWork(null, fba(), 'f', 'FBA', 200, 0, 150), null);
});
test('Partial shipment counts only remaining pieces', () => {
  assert.equal(c.summarizeFbm(fbm(), '1234').lines[0].qty, 2);
  assert.equal(c.summarizeFbm(fbm({ linesByLineId: { a: { sku: 'S', reservedQty: 3, shippedQty: 3 } } }), 'o'), null);
});
test('Newly enabled, disabled, unverified or email-changed accounts do not get older events', () => {
  const prefs = { enabled: true, enabledAt: 100, email: user.email };
  assert.equal(c.selectedForEvent(prefs, user, directory, 200), true);
  assert.equal(c.selectedForEvent(prefs, user, directory, 50), false);
  assert.equal(c.selectedForEvent({ ...prefs, enabled: false }, user, directory, 200), false);
  assert.equal(c.selectedForEvent(prefs, { ...user, disabled: true }, directory, 200), false);
  assert.equal(c.selectedForEvent(prefs, { ...user, emailVerified: false }, directory, 200), false);
  assert.equal(c.selectedForEvent(prefs, { ...user, email: 'changed@example.com' }, directory, 200), false);
});
test('Disabled UID overrides older active email invitation', () => {
  const entries = [{ id: user.uid, data: { enabled: false } }, { id: user.email, data: { enabled: true, isAdmin: true } }];
  assert.deepEqual(c.accessFor(user, entries), { member: false, admin: false });
});
test('Worker membership does not confer administrator access', () => {
  assert.equal(c.accessFor(user, directory).admin, false);
  assert.equal(c.accessFor(user, [{ id: 'worker', data: { enabled: true, isAdmin: false,
    admin: true, role: 'admin', userRole: 'administrator', roles: ['admin'] } }]).admin, false);
  assert.equal(c.accessFor(user, [{ id: 'worker', data: { enabled: true, isAdmin: true } }]).admin, true);
});
test('Mail uses the correct tab and includes operational counts only', () => {
  const work = c.summarizeFbm(fbm({ orderName: '#1234\r\nBcc: attacker@example.com', customerName: 'Private buyer' }), 'o');
  const message = c.buildMessage(work);
  assert.ok(!/[\r\n]/.test(message.subject));
  assert.ok(message.text.includes('?picking=fbm'));
  assert.ok(message.text.includes('1 SKU · 2 pezzi'));
  assert.ok(!message.text.includes('Private buyer'));
});
test('Only confirmed acceptance for the intended recipient counts as success', () => {
  assert.equal(c.deliveryOutcome({ state: 'SUCCESS', info: { accepted: [user.email] } }, user.email), 'SUCCESS');
  assert.equal(c.deliveryOutcome({ state: 'SUCCESS', info: { accepted: ['another@example.com'] } }, user.email), 'UNKNOWN');
  assert.equal(c.deliveryOutcome({ state: 'SUCCESS' }, user.email), 'UNKNOWN');
});
test('Delivery integrity survives Firestore map ordering but detects changed content', () => {
  const original = { to: user.email, from: 'Picking <sender@example.com>', kind: c.KIND,
    message: { subject: 'Nuovo ordine', text: 'Apri Picking' },
    picking: { uid: user.uid, eventId: 'event', channel: 'FBM', label: '#1234', sourcePath: 'orders/1234' } };
  const readBack = { ...original,
    message: { text: original.message.text, subject: original.message.subject },
    picking: Object.fromEntries(Object.entries(original.picking).sort(([a], [b]) => a.localeCompare(b))) };
  assert.equal(c.envelopeHash(original), c.envelopeHash(readBack));
  assert.notEqual(c.envelopeHash(original), c.envelopeHash({ ...readBack, message: { ...readBack.message, text: 'Changed' } }));
});
test('Retries are bounded and exclude permanent rejection and ambiguous DATA timeouts', () => {
  assert.equal(c.retryDelay({ state: 'ERROR', attempts: 1, error: '451 temporary failure' }), 60);
  assert.equal(c.retryDelay({ state: 'ERROR', attempts: 2, error: 'ECONNREFUSED' }), 300);
  assert.equal(c.retryDelay({ state: 'ERROR', attempts: 3, error: '451 temporary failure' }), 0);
  assert.equal(c.retryDelay({ state: 'ERROR', attempts: 1, error: '550 invalid recipient' }), 0);
  assert.equal(c.retryDelay({ state: 'ERROR', attempts: 1, error: 'ETIMEDOUT after DATA' }), 0);
  assert.equal(c.retryDelay({ state: 'SUCCESS', attempts: 1, error: '451' }), 0);
});

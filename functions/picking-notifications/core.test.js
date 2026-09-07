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
test('HTML mail matches Picking green/grey, escapes labels and contains only useful counts', () => {
  const message = c.buildMessage({ type: 'fba', label: 'FBA <script>alert(1)</script>\r\nUnsafe', totals: { fba: 2, fbm: 12 } });
  assert.ok(!/[\r\n]/.test(message.subject));
  assert.ok(message.text.includes('?picking=fba'));
  assert.ok(message.text.includes('2 flussi FBA da evadere'));
  assert.ok(message.text.includes('12 ordini FBM da evadere'));
  assert.ok(message.html.includes('#0f7078') && message.html.includes('#f6f7f9'));
  assert.ok(message.html.includes('&lt;script&gt;'));
  assert.ok(!message.html.includes('<script>') && !message.html.includes('#f97316'));
  assert.ok(c.buildMessage({ type: 'daily', totals: { fba: 0, fbm: 0 } }).html.includes('Riepilogo delle 08:00'));
  assert.ok(c.buildMessage({ totals: { fba: 1, fbm: 2 } }).text.includes('?picking=fbm'));
});
test('Pending totals deduplicate orders and exclude shipped, picked, cancelled and FBM mirror logs', () => {
  const orders = [{ id: '1', data: fbm() }, { id: 'duplicate', data: fbm() },
    { id: 'shipped', data: fbm({ orderId: '2', linesByLineId: { a: { sku: 'S', reservedQty: 2, inventoryAppliedQty: 2 } },
      orderDetails: { lineItems: [{ sku: 'S', quantity: 2 }] } }) },
    { id: 'cancelled', data: fbm({ orderId: '3', cancelled: true }) }];
  const flows = [{ id: 'f', data: fba() }, { id: 'f', data: fba() },
    { id: 'fbm-log', data: fba({ source: 'shopify_fbm', fileName: 'SHOPIFY_FBM' }) },
    { id: 'picked', data: fba({ lines: [{ sku: 'test/sku', qty: 2 }],
      picking: { managedByPicking: true, pickedLines: { TEST_SKU: { picked: true } } } }) }];
  assert.deepEqual(c.pendingTotals(flows, orders), { fba: 1, fbm: 1 });
  assert.equal(c.summarizeFbm(fbm({ linesByLineId: {}, orderDetails: { lineItems: [
    { sku: 'S', fulfillableQuantity: 0, currentQuantity: 3 }, { sku: 'GIFT', quantity: 1, giftCard: true },
  ] } }), 'o'), null);
});
test('08:00 daily slot follows Italian winter/summer time and rejects other hours and late replays', () => {
  for (const iso of ['2026-01-15T07:00:00Z', '2026-07-15T06:00:00Z', '2026-03-29T06:00:00Z', '2026-10-25T07:00:00Z']) {
    assert.ok(c.dailySlot(iso, Date.parse(iso) + 300000));
  }
  assert.equal(c.dailySlot('2026-07-15T07:00:00Z', Date.parse('2026-07-15T07:00:00Z')), null);
  assert.equal(c.dailySlot('2026-07-15T06:00:00Z', Date.parse('2026-07-16T06:00:00Z')), null);
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

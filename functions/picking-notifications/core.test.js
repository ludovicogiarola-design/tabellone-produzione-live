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
test('Operational email details assignee, products, pieces, urgency, location and procedure', () => {
  const details = c.pendingDetails([{ id: 'fba', data: fba({ workflowLabel: 'ID flusso di lavoro: private-uuid',
    workflow: { shipments: [{ code: 'FBA15TEST' }] }, lines: [
      { sku: 'NEEM500', title: 'Bionee Neem 500 ml – Prodotto naturale SKU: NEEM500 ASIN: PRIVATE', qty: 24 },
      { sku: 'SOAP', title: 'Sapone <script>alert(1)</script>', qty: 60 },
    ] }) }], [{ id: 'fbm', data: fbm() }]);
  const message = c.buildMessage({ type: 'fba', label: 'FBA15TEST', details, recipientName: 'Mario <Rossi>' });
  assert.ok(!/[\r\n]/.test(message.subject));
  assert.ok(message.text.includes('?picking=fba'));
  assert.equal(message.subject, 'Picking Concamarise | FBA urgente: 84 pezzi | FBM: 1 ordine');
  assert.ok(!message.subject.includes('NEEM500'));
  assert.ok(message.text.includes('Totale FBA: 84 pezzi · 2 prodotti'));
  assert.ok(message.text.includes('Stabilimento LG Trading SRL di Concamarise'));
  assert.ok(message.text.includes('Registrare in Picking i prelievi completati.'));
  assert.ok(message.html.includes('Amazon in arrivo per il carico'));
  assert.ok(message.html.includes('FBA15TEST'));
  assert.ok(!message.html.includes('flusso') && !message.html.includes('private-uuid'));
  assert.ok(!message.html.includes('ASIN: PRIVATE'));
  assert.ok(message.text.includes('Incaricato: Mario <Rossi>'));
  assert.ok(message.html.includes('Incaricato: Mario &lt;Rossi&gt;'));
  assert.ok(!message.html.includes('<Rossi>'));
  assert.ok(message.html.includes('&lt;script&gt;'));
  assert.ok(!message.html.includes('<script>'));
  assert.ok(message.html.includes('Procedura da seguire'));
});
test('Product aggregation totals pieces and preserves per-order allocations without duplicate documents', () => {
  const details = c.pendingDetails([
    { id: 'one', data: fba({ workflow: { shipments: [{ code: 'FBAFIRST' }] }, lines: [{ sku: ' sku-1 ', title: 'Prodotto 1 kg', qty: 4 }] }) },
    { id: 'two', data: fba({ workflow: { shipments: [{ code: 'FBASECOND' }] }, lines: [{ sku: 'SKU-1', title: 'Prodotto 1 kg', qty: 6 }] }) },
  ], [
    { id: 'one', data: fbm({ shopifyUpdatedAtClient: 100 }) },
    { id: 'duplicate', data: fbm({ shopifyUpdatedAtClient: 200, linesByLineId: { a: { sku: 'SKU-1', title: 'Prodotto 1 kg', reservedQty: 7, shippedQty: 2 } } }) },
  ]);
  assert.equal(details.fba.totalQty, 10);
  assert.equal(details.fba.skuCount, 1);
  assert.deepEqual(details.fba.products[0].references, [{ label: 'FBAFIRST', qty: 4 }, { label: 'FBASECOND', qty: 6 }]);
  assert.equal(details.fbm.totalQty, 5);
  assert.equal(details.fbm.orderCount, 1);
  assert.ok(c.buildMessage({ details }).text.includes('FBASECOND: 6 pezzi'));
});
test('Long product lists remain complete in the email with an explicitly bounded subject', () => {
  const lines = Array.from({ length: 160 }, (_, i) => ({ sku: 'SKU-' + i,
    title: 'Prodotto numero ' + i + ' – Descrizione completa da mantenere nella mail', qty: i + 1 }));
  const details = c.pendingDetails([{ id: 'f', data: fba({ lines }) }], []);
  const message = c.buildMessage({ details });
  assert.equal(message.subject, 'Picking Concamarise | FBA urgente: 12.880 pezzi');
  assert.ok(message.subject.length <= 100);
  for (const total of [Number.MAX_SAFE_INTEGER, 1e100]) {
    const large = c.buildMessage({ details: { fba: { ...details.fba, totalQty: total },
      fbm: { ...details.fbm, orderCount: total } } });
    assert.ok(large.subject.length <= 100);
    assert.ok(large.subject.includes('FBA urgente') && large.subject.includes('FBM'));
    assert.ok(!large.subject.includes('…'));
  }
  for (const line of lines) {
    assert.ok(message.html.includes('SKU: ' + line.sku + '</div>'));
    assert.ok(message.text.includes('SKU: ' + line.sku + ' | ' + line.qty + ' pezzi'));
  }
});
test('No FBA means no Amazon arrival claim; an empty digest does not request unnecessary work', () => {
  const onlyFbm = c.buildMessage({ type: 'daily', details: c.pendingDetails([], [{ id: 'o', data: fbm() }]) });
  assert.ok(onlyFbm.html.includes('ORE 08:00'));
  assert.ok(!onlyFbm.html.includes('Amazon in arrivo'));
  const empty = c.buildMessage({ details: c.pendingDetails([], []) });
  assert.ok(empty.subject.includes('Nessun prodotto da preparare'));
  assert.ok(!empty.html.includes('Procedura da seguire'));
  assert.ok(!empty.text.includes('Amazon in arrivo'));
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

'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { createService, CONFIG, RECIPIENTS, EVENTS, DELIVERIES } = require('./service');
const c = require('./core');

// Integration tests run exclusively against a local emulator and a demo project.
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8791') {
  test('Firestore integration tests need the local emulator', { skip: true }, () => {});
} else {
  const projectId = 'demo-picking-email-tests';
  const app = initializeApp({ projectId }, 'picking-email-tests');
  const db = getFirestore(app);
  const base = 'http://127.0.0.1:8791/emulator/v1/projects/' + projectId + '/databases/(default)/documents';
  const users = new Map();
  const tasks = new Map();
  const admin = { uid: 'admin', email: 'admin@example.com', emailVerified: true,
    displayName: 'Admin', metadata: { lastSignInTime: new Date().toISOString() } };
  const worker = { uid: 'worker', email: 'worker@example.com', emailVerified: true,
    displayName: 'Worker', metadata: { lastSignInTime: new Date().toISOString() } };
  const auth = {
    async verifyIdToken(token) {
      if (token === 'admin-token') return { uid: admin.uid, email: admin.email, email_verified: true };
      if (token === 'worker-token') return { uid: worker.uid, email: worker.email, email_verified: true };
      throw new Error('Invalid token');
    },
    async getUser(uid) {
      const user = users.get(uid);
      if (!user) { const error = new Error('Missing user'); error.code = 'auth/user-not-found'; throw error; }
      return user;
    },
    async getUsers(ids) {
      assert.ok(ids.length <= 100);
      return { users: [...new Set(ids.map(id => id.uid ? users.get(id.uid) :
        [...users.values()].find(user => user.email === id.email)).filter(Boolean))] };
    },
  };
  const service = createService({ db, auth,
    async scheduleRetry(data, opts) {
      tasks.set(tasks.size, { data, opts });
    },
  });
  let activatedAt;
  before(async () => { await fetch(base, { method: 'DELETE' }); });
  beforeEach(async () => {
    await fetch(base, { method: 'DELETE' });
    users.clear(); tasks.clear();
    users.set(admin.uid, { ...admin }); users.set(worker.uid, { ...worker });
    activatedAt = Date.now() - 60000;
    await db.doc(CONFIG).set({ activatedAt: Timestamp.fromMillis(activatedAt) });
    await db.doc('powderUsers/admin').set({ enabled: true, isAdmin: true, email: admin.email });
    await db.doc('powderUsers/worker').set({ enabled: true, isAdmin: false, email: worker.email });
  });
  after(async () => { await db.terminate(); await deleteApp(app); });
  async function select(uid = 'worker') {
    await service.api('Bearer admin-token', { action: 'setRecipient', uid, enabled: true, revision: 0 });
  }
  async function createWork(id = '1234', channel = 'FBA') {
    const ref = db.doc(channel === 'FBM' ? 'shopifyFbmOrders/' + id : 'amzInventory/concamarise/logs/' + id);
    const before = await ref.get();
    const data = channel === 'FBM' ? { active: true, orderId: id, orderName: '#' + id,
      shopifyCreatedAtClient: Date.now(), linesByLineId: { a: { sku: 'SKU', reservedQty: 5, shippedQty: 0 } } } :
      { kind: 'scarica', fileName: 'FBA123456', status: 'RESERVED', appliedAtClient: Date.now(),
        picking: { managedByPicking: true }, lines: [{ sku: 'SKU', qty: 4 }] };
    await ref.set(data);
    const after = await ref.get();
    return { id: 'event-' + id, data: { before, after }, params: channel === 'FBM' ? { orderId: id } : { flowId: id } };
  }
  async function firstMail() { return (await db.collection('email').get()).docs[0]; }
  async function deliver(mailRef, delivery) {
    const before = await mailRef.get();
    await mailRef.update({ delivery });
    const after = await mailRef.get();
    const event = { data: { before, after }, params: { mailId: mailRef.id } };
    await service.onDelivery(event);
    return event;
  }

  test('API blocks absent/invalid credentials and operators, regardless of supplied admin UID', async () => {
    for (const bearer of ['', 'Bearer invalid']) {
      await assert.rejects(service.api(bearer, { action: 'list' }), error => error.status === 401);
    }
    await assert.rejects(service.api('Bearer worker-token', { action: 'setRecipient', uid: 'admin', enabled: true, revision: 0 }),
      error => error.status === 403);
    await db.doc('powderUsers/worker').update({ admin: true, role: 'admin', userRole: 'administrator', roles: ['admin'] });
    await assert.rejects(service.api('Bearer worker-token', { action: 'list' }), error => error.status === 403);
  });
  test('Roster deduplicates email invitations and UID records using Auth email', async () => {
    await db.doc('powderUsers/worker@example.com').set({ enabled: true, name: 'Invitation' });
    const result = await service.api('Bearer admin-token', { action: 'list' });
    assert.equal(result.users.filter(row => row.uid === 'worker').length, 1);
    assert.equal(result.users.find(row => row.uid === 'worker').email, worker.email);
    assert.equal(result.users.find(row => row.uid === 'worker').lastAccessAt, Date.parse(worker.metadata.lastSignInTime));
  });
  test('Selection is versioned and rejects stale concurrent edits', async () => {
    await select();
    await assert.rejects(service.api('Bearer admin-token', { action: 'setRecipient', uid: 'worker', enabled: false, revision: 0 }),
      error => error.status === 409);
    assert.equal((await db.doc(RECIPIENTS + '/worker').get()).data().enabled, true);
  });
  test('Concurrent duplicate events create one email and one ledger entry', async () => {
    await select();
    const event = await createWork();
    await Promise.all([service.onNewWork(event, 'FBA'), service.onNewWork(event, 'FBA')]);
    assert.equal((await db.collection('email').get()).size, 1);
    assert.equal((await db.collection(EVENTS).get()).size, 1);
    assert.equal((await firstMail()).data().to, worker.email);
  });
  test('FBA queues independently and ordinary order updates do not send again', async () => {
    await select();
    const event = await createWork('fba', 'FBA');
    await service.onNewWork(event, 'FBA');
    const before = await event.data.after.ref.get();
    await before.ref.update({ unrelated: 'resync' });
    await service.onNewWork({ data: { before, after: await before.ref.get() }, params: event.params }, 'FBA');
    assert.equal((await db.collection('email').get()).size, 1);
    assert.ok((await firstMail()).data().message.text.includes('?picking=fba'));
  });
  test('FBM order arrivals and updates never send an automatic email', async () => {
    await select();
    const event = await createWork('fbm', 'FBM');
    await service.onNewWork(event, 'FBM');
    await event.data.after.ref.update({ updatedAtClient: Date.now() });
    await service.onNewWork({ ...event, data: { before: event.data.after, after: await event.data.after.ref.get() } }, 'FBM');
    assert.equal((await db.collection('email').get()).size, 0);
    assert.deepEqual(await service.readPendingSummary(), { fba: 0, fbm: 1 });
  });
  test('Manual summary uses only selected Auth recipients and remains idempotent after a lost response', async () => {
    await select();
    await createWork('fba');
    await createWork('fbm', 'FBM');
    const request = { action: 'sendSummary', requestId: 'manual_request_123456', to: 'injected@example.com' };
    await assert.rejects(service.api('Bearer worker-token', request), error => error.status === 403);
    const results = await Promise.all([service.api('Bearer admin-token', request), service.api('Bearer admin-token', request)]);
    assert.deepEqual(results[0].totals, { fba: 1, fbm: 1 });
    assert.equal(results[0].queuedCount, 1);
    assert.equal(results.filter(r => r.alreadyQueued).length, 1);
    assert.equal((await db.collection('email').get()).size, 1);
    const mail = (await firstMail()).data();
    assert.equal(mail.to, worker.email);
    assert.equal(mail.picking.noticeType, 'manual');
    assert.ok(mail.message.html.includes('AVVISO OPERATIVO'));
    assert.equal(mail.from, 'LG Trading SRL - Picking Concamarise <info@generalcoppersrl.com>');
    assert.deepEqual(results[0].summaryCounts, { fbaPieces: 4, fbaProducts: 1, fbmOrders: 1, fbmPieces: 5, fbmProducts: 1 });
    await assert.rejects(service.api('Bearer admin-token', { ...request, requestId: 'another_request_123456' }),
      error => error.status === 429);
  });
  test('Each selected recipient receives their own current account name as assignee', async () => {
    await select();
    users.get(worker.uid).displayName = 'Mario <Rossi>';
    const second = { ...worker, uid: 'worker2', email: 'second@example.com', displayName: 'Sara Bianchi' };
    users.set(second.uid, second);
    await db.doc('powderUsers/worker2').set({ enabled: true, isAdmin: false, email: second.email });
    await select(second.uid);
    await createWork('assigned-fba');
    const result = await service.api('Bearer admin-token', {
      action: 'sendSummary', requestId: 'assigned_request_123456', recipientName: 'Injected name',
    });
    assert.equal(result.queuedCount, 2);
    const mails = (await db.collection('email').get()).docs.map(doc => doc.data());
    const first = mails.find(mail => mail.to === worker.email);
    const other = mails.find(mail => mail.to === second.email);
    assert.ok(first.message.text.includes('Incaricato: Mario <Rossi>'));
    assert.ok(first.message.html.includes('Incaricato: Mario &lt;Rossi&gt;'));
    assert.ok(other.message.text.includes('Incaricato: Sara Bianchi'));
    assert.ok(!first.message.text.includes('Sara Bianchi'));
    assert.ok(!other.message.text.includes('Mario <Rossi>'));
    assert.ok(mails.every(mail => !mail.message.text.includes('Injected name')));
  });
  test('Manual summary requires a recipient and can report zero pending work', async () => {
    const request = { action: 'sendSummary', requestId: 'manual_zero_123456' };
    await assert.rejects(service.api('Bearer admin-token', request), error => error.status === 400);
    assert.equal((await db.collection('email').get()).size, 0);
    await select();
    assert.deepEqual((await service.api('Bearer admin-token', request)).totals, { fba: 0, fbm: 0 });
  });
  test('The 08:00 digest includes all pending work and concurrent schedule retries send only once', async () => {
    await select();
    const legacy = await createWork('old-fba');
    await legacy.data.after.ref.set({ kind: 'scarica', fileName: 'FBALEGACY',
      picking: { managedByPicking: true }, lines: [{ sku: 'SKU', qty: 3 }] });
    const completed = await createWork('done-fba');
    await completed.data.after.ref.update({ status: 'PICKED', 'picking.flowPicked': true });
    await createWork('fbm', 'FBM');
    const picked = await createWork('picked-fbm', 'FBM');
    await picked.data.after.ref.update({ 'linesByLineId.a.inventoryAppliedQty': 5 });
    const scheduled = { scheduleTime: '2030-07-01T06:00:00Z' };
    const daily = createService({ db, auth, scheduleRetry: async () => {}, clock: () => Date.parse(scheduled.scheduleTime) });
    const results = await Promise.all([daily.onDaily(scheduled), daily.onDaily(scheduled)]);
    assert.deepEqual(results[0].totals, { fba: 1, fbm: 1 });
    assert.equal((await db.collection('email').get()).size, 1);
    assert.equal((await firstMail()).data().picking.noticeType, 'daily');
    assert.ok((await firstMail()).data().message.html.includes('ORE 08:00'));
    assert.equal((await daily.onDaily({ scheduleTime: '2030-07-01T07:00:00Z' })).outcome, 'outside_schedule');
  });
  test('Daily selection after the scheduled time does not receive a delayed digest', async () => {
    await select();
    const scheduled = { scheduleTime: '2030-07-01T06:00:00Z' };
    const time = Date.parse(scheduled.scheduleTime);
    await db.doc(RECIPIENTS + '/worker').update({ enabledAt: Timestamp.fromMillis(time + 1000) });
    const daily = createService({ db, auth, scheduleRetry: async () => {}, clock: () => time + 10000 });
    assert.equal((await daily.onDaily(scheduled)).queuedCount, 0);
    assert.equal((await db.collection('email').get()).size, 0);
  });
  test('Summary delivery uses the same confirmed log and retries safely without a source order', async () => {
    await select();
    await service.api('Bearer admin-token', { action: 'sendSummary', requestId: 'manual_retry_123456' });
    const mail = await firstMail();
    await deliver(mail.ref, { state: 'ERROR', attempts: 1, error: '451 temporary failure', endTime: Timestamp.now() });
    await service.retryEmail({ data: [...tasks.values()][0].data });
    assert.equal((await mail.ref.get()).data().delivery.state, 'RETRY');
    const endTime = Timestamp.now();
    await deliver(mail.ref, { state: 'SUCCESS', attempts: 2, endTime, info: { accepted: [worker.email] } });
    const prefs = (await db.doc(RECIPIENTS + '/worker').get()).data();
    assert.equal(prefs.lastSentAt.toMillis(), endTime.toMillis());
    assert.equal(prefs.lastSentChannel, 'RIEPILOGO');
  });
  test('Detailed summary resolves legacy product titles and keeps exact remaining FBM quantities', async () => {
    await select();
    await createWork('fba');
    await db.doc('amzInventory/concamarise/items/SKU').set({ sku: 'SKU', title: 'Mastice 1 kg SKU: SKU ASIN: OMIT' });
    const order = await createWork('fbm', 'FBM');
    await order.data.after.ref.update({ 'linesByLineId.a.inventoryAppliedQty': 2,
      orderName: '##52391', orderDetails: { lineItems: [{ sku: 'SKU', title: 'Mastice per potature 1 kg' }] } });
    const result = await service.api('Bearer admin-token', { action: 'sendSummary', requestId: 'product_detail_123456' });
    const mail = (await firstMail()).data();
    assert.equal(result.summaryCounts.fbaPieces, 4);
    assert.equal(result.summaryCounts.fbmPieces, 3);
    assert.ok(mail.message.html.includes('Mastice 1 kg'));
    assert.ok(mail.message.html.includes('Mastice per potature 1 kg'));
    assert.ok(mail.message.text.includes('#52391: 3 pezzi'));
    assert.ok(!mail.message.text.includes('ASIN: OMIT'));
    assert.ok(!mail.message.text.includes('##52391'));
  });
  test('No selected recipients means no send and no backfill on later selection', async () => {
    const event = await createWork();
    await service.onNewWork(event, 'FBA');
    await select();
    await service.onNewWork(event, 'FBA');
    assert.equal((await db.collection('email').get()).size, 0);
  });
  test('Cancellation before processing prevents an email', async () => {
    await select();
    const event = await createWork();
    await event.data.after.ref.update({ voided: true });
    await service.onNewWork(event, 'FBA');
    assert.equal((await db.collection('email').get()).size, 0);
  });
  test('Auth deactivation after selection suppresses the next alert', async () => {
    await select();
    users.set(worker.uid, { ...worker, disabled: true });
    const event = await createWork();
    await service.onNewWork(event, 'FBA');
    assert.equal((await db.collection('email').get()).size, 0);
  });
  test('Queued mail has no sent timestamp; confirmed SMTP success updates the mini log', async () => {
    await select();
    await service.onNewWork(await createWork(), 'FBA');
    assert.equal(c.millis((await db.doc(RECIPIENTS + '/worker').get()).data().lastSentAt), 0);
    const mail = await firstMail(), endTime = Timestamp.now();
    await deliver(mail.ref, { state: 'SUCCESS', attempts: 1, endTime, info: { accepted: [worker.email] } });
    const row = (await service.api('Bearer admin-token', { action: 'status' })).users.find(row => row.uid === worker.uid);
    assert.equal(row.lastSentAt, endTime.toMillis());
    assert.equal(row.lastStatus, 'SUCCESS');
  });
  test('Old success events cannot move the last sent time backward', async () => {
    await select();
    await service.onNewWork(await createWork('first'), 'FBA');
    const first = await firstMail();
    const firstEnd = Timestamp.fromMillis(Date.now() - 1000);
    const oldEvent = await deliver(first.ref, { state: 'SUCCESS', attempts: 1, endTime: firstEnd, info: { accepted: [worker.email] } });
    await service.onNewWork(await createWork('second'), 'FBA');
    const second = (await db.collection('email').get()).docs.find(doc => doc.id !== first.id);
    const secondEnd = Timestamp.now();
    await deliver(second.ref, { state: 'SUCCESS', attempts: 1, endTime: secondEnd, info: { accepted: [worker.email] } });
    await service.onDelivery(oldEvent);
    assert.equal((await db.doc(RECIPIENTS + '/worker').get()).data().lastSentAt.toMillis(), secondEnd.toMillis());
  });
  test('Duplicate error callbacks cannot trigger multiple SMTP retries', async () => {
    await select();
    await service.onNewWork(await createWork(), 'FBA');
    const mail = await firstMail();
    const event = await deliver(mail.ref, { state: 'ERROR', attempts: 1, error: '451 temporary failure', endTime: Timestamp.now() });
    await service.onDelivery(event);
    assert.equal(tasks.size, 2);
    await Promise.all([...tasks.values()].map(task => service.retryEmail({ data: task.data })));
    assert.equal((await mail.ref.get()).data().delivery.state, 'RETRY');
    assert.equal((await db.collection('email').get()).size, 1);
  });
  test('Deselecting a recipient cancels a pending retry', async () => {
    await select();
    await service.onNewWork(await createWork(), 'FBA');
    const mail = await firstMail();
    await deliver(mail.ref, { state: 'ERROR', attempts: 1, error: '451 temporary failure', endTime: Timestamp.now() });
    await service.api('Bearer admin-token', { action: 'setRecipient', uid: 'worker', enabled: false, revision: 1 });
    await service.retryEmail({ data: [...tasks.values()][0].data });
    assert.equal((await mail.ref.get()).data().delivery.state, 'ERROR');
    assert.equal((await db.doc(DELIVERIES + '/' + mail.id).get()).data().lastStatus, 'CANCELLED');
  });
  test('Forged mail metadata cannot change another user log or enqueue retries', async () => {
    const ref = db.doc('email/' + c.PREFIX + c.hash('forged'));
    await ref.set({ to: worker.email, kind: c.KIND, picking: { uid: worker.uid },
      delivery: { state: 'SUCCESS', endTime: Timestamp.now(), info: { accepted: [worker.email] } } });
    await service.onDelivery({ data: { after: await ref.get() }, params: { mailId: ref.id } });
    assert.equal((await db.doc(RECIPIENTS + '/worker').get()).exists, false);
    assert.equal(tasks.size, 0);
  });
}

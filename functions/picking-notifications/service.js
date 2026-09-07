'use strict';

const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const c = require('./core');
const CONFIG = 'pickingEmailConfig/system';
const RECIPIENTS = 'pickingEmailRecipients';
const EVENTS = 'pickingEmailEvents';
const DELIVERIES = 'pickingEmailDeliveries';
const DIRECTORY_COLLECTIONS = ['powderUsers', 'amzInventoryDirectory', 'payrollDirectory'];

function problem(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createService({ db, auth, scheduleRetry, logger = console }) {
  async function readDirectory() {
    const snapshots = await Promise.all(DIRECTORY_COLLECTIONS.map(name => db.collection(name).get()));
    return snapshots.flatMap((snap, i) => snap.docs.map(doc => ({
      collection: DIRECTORY_COLLECTIONS[i], id: doc.id, data: doc.data(),
    })));
  }

  async function verifyAdmin(bearer) {
    if (!/^Bearer [A-Za-z0-9_.-]+$/.test(bearer || '')) throw problem(401, 'Accedi a Picking per continuare.');
    let token;
    try { token = await auth.verifyIdToken(bearer.slice(7), true); }
    catch (_) { throw problem(401, 'Sessione scaduta. Accedi di nuovo.'); }
    if (!token.uid || token.email_verified !== true) throw problem(403, 'Operazione riservata agli amministratori.');
    const refs = DIRECTORY_COLLECTIONS.flatMap(name => [
      db.doc(name + '/' + token.uid),
      ...(c.validEmail(token.email) ? [db.doc(name + '/' + c.email(token.email))] : []),
    ]);
    const snaps = await db.getAll(...refs);
    const directory = snaps.filter(s => s.exists).map(s => ({ id: s.id, data: s.data() }));
    const access = c.accessFor({ uid: token.uid, email: token.email, emailVerified: true }, directory);
    if (!access.admin) throw problem(403, 'Operazione riservata agli amministratori.');
    return token;
  }

  async function getRegisteredUsers(directory) {
    const identifiers = new Map();
    for (const row of directory) {
      const key = row.id;
      if (c.validEmail(key)) identifiers.set('email:' + c.email(key), { email: c.email(key) });
      else if (/^[^/]{1,128}$/.test(key)) identifiers.set('uid:' + key, { uid: key });
    }
    const values = [...identifiers.values()];
    const users = new Map();
    for (let i = 0; i < values.length; i += 100) {
      const result = await auth.getUsers(values.slice(i, i + 100));
      for (const user of result.users) users.set(user.uid, user);
    }
    return [...users.values()];
  }

  function userRow(user, directory, settings = {}) {
    const access = c.accessFor(user, directory);
    const profile = directory.find(row => row.id === user.uid)?.data ||
      directory.find(row => row.id === c.email(user.email))?.data || {};
    const available = access.member && user.emailVerified === true && !!user.metadata?.lastSignInTime;
    return {
      uid: user.uid, name: c.clean(user.displayName || profile.displayName || profile.name || user.email),
      email: c.email(user.email), available,
      reason: !access.member ? 'Utente non abilitato' : user.emailVerified !== true ? 'Email da verificare' :
        settings.enabled && settings.email !== c.email(user.email) ? 'Email cambiata: disattiva e riattiva le notifiche.' :
        !user.metadata?.lastSignInTime ? 'Primo accesso da completare' : '',
      enabled: settings.enabled === true, revision: settings.revision || 0,
      lastSentAt: c.millis(settings.lastSentAt), lastChannel: settings.lastSentChannel || '',
      lastStatus: settings.lastStatus || '', lastQueuedAt: c.millis(settings.lastQueuedAt),
    };
  }

  async function listRecipients() {
    const [directory, settings, config] = await Promise.all([
      readDirectory(), db.collection(RECIPIENTS).get(), db.doc(CONFIG).get(),
    ]);
    const users = await getRegisteredUsers(directory);
    const byUid = new Map(settings.docs.map(s => [s.id, s.data()]));
    const rows = users.filter(user => c.validEmail(user.email) &&
        (c.accessFor(user, directory).member || byUid.get(user.uid)?.enabled))
      .map(user => userRow(user, directory, byUid.get(user.uid)))
      .sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
    // Deleted Auth users with an existing subscription can still be deselected.
    for (const doc of settings.docs) {
      if (doc.data().enabled && !users.some(user => user.uid === doc.id)) {
        const data = doc.data();
        rows.push({ uid: doc.id, name: data.name || data.email || 'Utente non disponibile',
          email: data.email || '', available: false, reason: 'Account non disponibile',
          enabled: true, revision: data.revision || 0, lastSentAt: c.millis(data.lastSentAt),
          lastChannel: data.lastSentChannel || '', lastStatus: data.lastStatus || '' });
      }
    }
    return { users: rows, ready: config.exists && !!config.data().activatedAt };
  }

  async function status() {
    const snap = await db.collection(RECIPIENTS).get();
    return { users: snap.docs.map(doc => {
      const d = doc.data();
      return { uid: doc.id, enabled: d.enabled === true, revision: d.revision || 0,
        lastSentAt: c.millis(d.lastSentAt), lastChannel: d.lastSentChannel || '',
        lastStatus: d.lastStatus || '', lastQueuedAt: c.millis(d.lastQueuedAt) };
    }) };
  }

  async function setRecipient(actor, input) {
    const { uid, enabled, revision } = input;
    if (typeof uid !== 'string' || !/^[^/]{1,128}$/.test(uid) ||
        typeof enabled !== 'boolean' || !Number.isInteger(revision) || revision < 0) {
      throw problem(400, 'Selezione non valida.');
    }
    let user, directory;
    if (enabled) {
      directory = await readDirectory();
      try { user = await auth.getUser(uid); }
      catch (error) {
        if (error.code === 'auth/user-not-found') throw problem(400, 'Account non disponibile.');
        throw error;
      }
      if (!userRow(user, directory).available) throw problem(400, 'Questo utente non può ricevere notifiche.');
    }
    const ref = db.doc(RECIPIENTS + '/' + uid);
    await db.runTransaction(async tx => {
      const [snap, config] = await tx.getAll(ref, db.doc(CONFIG));
      if (!config.exists || !config.data().activatedAt) throw problem(503, 'Servizio in attivazione. Riprova tra poco.');
      const previous = snap.data() || {};
      if ((previous.revision || 0) !== revision) throw problem(409, 'La selezione è cambiata. Aggiorna e riprova.');
      if (previous.enabled === enabled && (!enabled || previous.email === c.email(user.email))) return;
      tx.set(ref, {
        enabled, revision: revision + 1, updatedAt: FieldValue.serverTimestamp(), updatedByUid: actor.uid,
        ...(enabled ? { email: c.email(user.email), name: c.clean(user.displayName || user.email),
          enabledAt: FieldValue.serverTimestamp() } : {}),
      }, { merge: true });
    });
    return status();
  }

  async function api(bearer, body) {
    const actor = await verifyAdmin(bearer);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem(400, 'Richiesta non valida.');
    if (body.action === 'list') return listRecipients();
    if (body.action === 'status') return status();
    if (body.action === 'setRecipient') return setRecipient(actor, body);
    throw problem(400, 'Richiesta non valida.');
  }

  async function onNewWork(event, channel) {
    const after = event.data?.after;
    const before = event.data?.before;
    if (!after?.exists) return;
    const occurredAt = c.millis(after.updateTime) || c.millis(event.time);
    const id = channel === 'FBA' ? event.params.flowId : event.params.orderId;
    const config = await db.doc(CONFIG).get();
    const activatedAt = c.millis(config.data()?.activatedAt);
    const work = c.newWork(before?.exists ? before.data() : null, after.data(), id, channel,
      occurredAt, activatedAt, c.millis(after.createTime));
    if (!work) return;
    const eventId = c.hash(work.key);
    const eventRef = db.doc(EVENTS + '/' + eventId);
    const selected = await db.collection(RECIPIENTS).where('enabled', '==', true).get();
    const directory = selected.empty ? [] : await readDirectory();
    const authUsers = [];
    for (let i = 0; i < selected.docs.length; i += 100) {
      const batch = await auth.getUsers(selected.docs.slice(i, i + 100).map(d => ({ uid: d.id })));
      authUsers.push(...batch.users);
    }
    const byUid = new Map(authUsers.map(user => [user.uid, user]));
    const candidates = selected.docs.filter(doc => c.selectedForEvent(doc.data(), byUid.get(doc.id), directory, occurredAt));
    const now = Date.now();
    await db.runTransaction(async tx => {
      const refs = [eventRef, after.ref, ...candidates.map(s => s.ref)];
      const [ledger, source, ...recipients] = await tx.getAll(...refs);
      if (ledger.exists) return;
      const current = channel === 'FBA' ? c.summarizeFba(source.data(), id) : c.summarizeFbm(source.data(), id);
      const active = current && now - occurredAt < 24 * 60 * 60 * 1000;
      const eligible = active ? recipients.filter((doc, i) => doc.exists &&
        doc.data().revision === candidates[i].data().revision &&
        c.selectedForEvent(doc.data(), byUid.get(doc.id), directory, occurredAt)) : [];
      const mailRefs = eligible.map(doc => db.doc('email/' + c.PREFIX + c.hash(eventId + ':' + doc.id)));
      const existing = mailRefs.length ? await tx.getAll(...mailRefs) : [];
      if (existing.some(doc => doc.exists)) throw problem(500, 'Collisione nella coda email.');
      const message = c.buildMessage(current || work);
      for (let i = 0; i < eligible.length; i++) {
        const recipient = eligible[i], data = recipient.data(), mailRef = mailRefs[i];
        const mail = {
          to: data.email, from: 'Picking <info@generalcoppersrl.com>', replyTo: 'info@generalcoppersrl.com',
          message, kind: c.KIND,
          picking: { uid: recipient.id, eventId, channel, label: work.label, sourcePath: after.ref.path },
          createdAt: FieldValue.serverTimestamp(),
        };
        tx.create(mailRef, mail);
        tx.create(db.doc(DELIVERIES + '/' + mailRef.id), {
          uid: recipient.id, email: data.email, recipientRevision: data.revision, eventId,
          channel, label: work.label, sourcePath: after.ref.path, sourceId: id,
          occurredAt: Timestamp.fromMillis(occurredAt), createdAt: FieldValue.serverTimestamp(),
          envelopeHash: c.envelopeHash(mail), lastStatus: 'PENDING',
        });
        if (occurredAt >= c.millis(data.lastQueuedAt)) {
          tx.set(recipient.ref, { lastQueuedAt: Timestamp.fromMillis(occurredAt),
            lastMailId: mailRef.id, lastStatus: 'PENDING' }, { merge: true });
        }
      }
      tx.create(eventRef, { key: work.key, channel, sourcePath: after.ref.path,
        occurredAt: Timestamp.fromMillis(occurredAt), processedAt: FieldValue.serverTimestamp(),
        recipientUids: eligible.map(doc => doc.id), outcome: !active ? 'no_longer_pending' :
          eligible.length ? 'queued' : 'no_selected_recipients' });
    });
  }

  async function onDelivery(event) {
    const after = event.data?.after;
    const mailId = event.params.mailId;
    if (!mailId?.startsWith(c.PREFIX) || !after?.exists) return;
    const mail = after.data();
    if (mail.kind !== c.KIND || !mail.delivery) return;
    const ref = db.doc(DELIVERIES + '/' + mailId);
    const ledger = await ref.get();
    if (!ledger.exists || ledger.data().envelopeHash !== c.envelopeHash(mail)) return;
    const data = ledger.data();
    const recipientRef = db.doc(RECIPIENTS + '/' + data.uid);
    const outcome = c.deliveryOutcome(mail.delivery, data.email);
    const delay = c.retryDelay(mail.delivery);
    const attempt = Math.max(1, c.number(mail.delivery.attempts));
    const completion = c.millis(mail.delivery.endTime);
    await db.runTransaction(async tx => {
      const [current, recipient, currentMail] = await tx.getAll(ref, recipientRef, after.ref);
      if (!current.exists || !currentMail.exists || current.data().envelopeHash !== c.envelopeHash(currentMail.data())) return;
      // Eventarc may deliver old delivery events after more recent ones.
      if (!currentMail.updateTime.isEqual(after.updateTime)) return;
      tx.set(ref, { lastStatus: outcome, attempts: attempt, updatedAt: FieldValue.serverTimestamp(),
        ...(outcome === 'SUCCESS' && completion ? { sentAt: Timestamp.fromMillis(completion) } : {}),
      }, { merge: true });
      if (recipient.exists) {
        const previous = recipient.data();
        const patch = {};
        if (previous.lastMailId === mailId) patch.lastStatus = outcome;
        if (outcome === 'SUCCESS' && completion > c.millis(previous.lastSentAt)) {
          patch.lastSentAt = Timestamp.fromMillis(completion);
          patch.lastSentChannel = data.channel;
        }
        if (Object.keys(patch).length) tx.set(recipientRef, patch, { merge: true });
      }
    });
    if (delay) {
      await scheduleRetry({ mailId, attempt }, { scheduleDelaySeconds: delay });
    }
  }

  async function retryEmail(request) {
    const { mailId, attempt } = request.data || {};
    if (typeof mailId !== 'string' || !/^picking_email_[a-f0-9]{64}$/.test(mailId) ||
        !Number.isInteger(attempt) || attempt < 1 || attempt >= 3) return;
    const ledgerRef = db.doc(DELIVERIES + '/' + mailId);
    const ledger = await ledgerRef.get();
    if (!ledger.exists) return;
    const data = ledger.data();
    let user;
    try { user = await auth.getUser(data.uid); }
    catch (error) { if (error.code !== 'auth/user-not-found') throw error; }
    const directory = user ? await readDirectory() : [];
    const mailRef = db.doc('email/' + mailId), recipientRef = db.doc(RECIPIENTS + '/' + data.uid);
    await db.runTransaction(async tx => {
      const [mailSnap, recipient, source] = await tx.getAll(mailRef, recipientRef, db.doc(data.sourcePath));
      if (!mailSnap.exists || !recipient.exists) return;
      const mail = mailSnap.data(), prefs = recipient.data();
      if (c.envelopeHash(mail) !== data.envelopeHash || !c.retryDelay(mail.delivery) ||
          Math.max(1, c.number(mail.delivery.attempts)) !== attempt) return;
      const pending = data.channel === 'FBA' ? c.summarizeFba(source.data(), data.sourceId) : c.summarizeFbm(source.data(), data.sourceId);
      if (!pending || prefs.revision !== data.recipientRevision ||
          !c.selectedForEvent(prefs, user, directory, c.millis(data.occurredAt))) {
        tx.set(ledgerRef, { lastStatus: 'CANCELLED' }, { merge: true });
        if (prefs.lastMailId === mailId) tx.set(recipientRef, { lastStatus: 'CANCELLED' }, { merge: true });
        return;
      }
      tx.update(mailRef, { 'delivery.state': 'RETRY' });
      tx.set(ledgerRef, { lastStatus: 'RETRY', retriedAt: FieldValue.serverTimestamp() }, { merge: true });
      if (prefs.lastMailId === mailId) tx.set(recipientRef, { lastStatus: 'RETRY' }, { merge: true });
    });
  }

  return { api, onNewWork, onDelivery, retryEmail, listRecipients, verifyAdmin };
}

module.exports = { createService, CONFIG, RECIPIENTS, EVENTS, DELIVERIES };

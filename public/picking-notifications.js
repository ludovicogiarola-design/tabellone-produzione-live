export function createPickingNotifications({ root, getUser, isActive }) {
  const endpoint = 'https://europe-west1-tabellone-produzione-liv-e313e.cloudfunctions.net/pickingEmailApi';
  const rows = new Map();
  let session = 0, timer = null, ownerUid = '', loading = false, sending = false, manualRequestId = '';
  const status = root.querySelector('[data-mail-status]');
  const list = root.querySelector('[data-mail-list]');
  const refresh = root.querySelector('[data-mail-refresh]');
  const send = root.querySelector('[data-mail-send]');
  const element = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const formatTime = value => value ? new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value)) : 'Nessuna email inviata';

  async function request(body) {
    const user = getUser();
    if (!user || user.uid !== ownerUid) throw new Error('Accedi di nuovo a Picking.');
    const expectedSession = session;
    const token = await user.getIdToken();
    if (session !== expectedSession || getUser()?.uid !== user.uid) throw new Error('La sessione è cambiata.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal, cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok) {
        const error = new Error(result.error || 'Impossibile completare la richiesta.');
        error.status = response.status;
        throw error;
      }
      if (getUser()?.uid !== ownerUid) throw new Error('La sessione è cambiata.');
      return result;
    } finally { clearTimeout(timeout); }
  }

  function setFeedback(message, error = false) {
    status.textContent = message;
    status.classList.toggle('pickingMailError', error);
  }

  function syncControls() {
    const saving = [...rows.values()].some(row => row.saving);
    refresh.disabled = loading || sending || saving;
    if (send) {
      send.disabled = loading || sending || saving ||
        ![...rows.values()].some(row => row.data.enabled && row.data.available);
      send.textContent = sending ? 'Invio…' : 'Invia riepilogo';
    }
    for (const row of rows.values()) {
      row.checkbox.disabled = sending || row.saving || (!row.data.available && !row.data.enabled);
    }
  }

  function paint(row, data) {
    row.data = { ...row.data, ...data };
    const user = row.data;
    if (!row.saving) row.checkbox.checked = user.enabled;
    row.checkbox.disabled = row.saving || (!user.available && !user.enabled);
    row.access.textContent = user.lastAccessAt ? formatTime(user.lastAccessAt) : 'Non disponibile';
    row.sent.textContent = formatTime(user.lastSentAt);
    row.sent.title = user.lastSentAt ? 'Ultima email inviata · ' + (user.lastChannel || '') : '';
    const labels = {
      PENDING: 'In attesa di invio', PROCESSING: 'Invio in corso', RETRY: 'Nuovo tentativo in attesa',
      ERROR: 'Ultimo invio non riuscito', UNKNOWN: 'Esito da verificare', CANCELLED: 'Invio annullato',
    };
    row.detail.textContent = row.saving ? 'Salvataggio…' : user.reason || labels[user.lastStatus] || '';
    row.detail.classList.toggle('pickingMailError', ['ERROR', 'UNKNOWN'].includes(user.lastStatus));
  }

  function draw(users) {
    rows.clear();
    list.replaceChildren();
    if (!users.length) {
      list.append(element('div', 'pickingMailEmpty', 'Nessun utente abilitato disponibile.'));
      return;
    }
    for (const user of users) {
      const item = element('div', 'pickingMailRow');
      const label = element('label', 'pickingMailPerson');
      const checkbox = element('input', 'pickingMailCheckbox');
      checkbox.type = 'checkbox';
      checkbox.setAttribute('aria-label', 'Notifiche email per ' + user.name);
      const identity = element('span', 'pickingMailIdentity');
      identity.append(element('span', 'pickingMailName', user.name),
        element('span', 'pickingMailAddress', user.email));
      label.append(checkbox, identity);
      const log = element('div', 'pickingMailLog');
      const accessCell = element('div', 'pickingMailAccess');
      const access = element('span', 'pickingMailSent');
      access.title = 'Ultima autenticazione dell’account';
      accessCell.append(element('span', 'pickingMailCellLabel', 'Ultimo accesso'), access);
      const sent = element('span', 'pickingMailSent');
      const detail = element('span', 'pickingMailDetail');
      log.append(element('span', 'pickingMailCellLabel', 'Ultima email inviata'), sent, detail);
      item.append(label, accessCell, log);
      list.append(item);
      const row = { data: user, checkbox, access, sent, detail, saving: false };
      rows.set(user.uid, row);
      paint(row, user);
      checkbox.addEventListener('change', async () => {
        const expectedSession = session, enabled = checkbox.checked, revision = row.data.revision;
        row.saving = true;
        paint(row, {});
        syncControls();
        try {
          const result = await request({ action: 'setRecipient', uid: user.uid, enabled, revision });
          if (session !== expectedSession) return;
          row.saving = false;
          for (const latest of result.users || []) {
            const current = rows.get(latest.uid);
            if (current && (!current.saving || current === row)) paint(current, latest);
          }
          setFeedback(enabled ? 'Notifiche attivate.' : 'Notifiche disattivate.');
        } catch (error) {
          if (session !== expectedSession) return;
          row.saving = false;
          paint(row, {});
          setFeedback(error.name === 'AbortError' ? 'Salvataggio da verificare. Premi Aggiorna.' : error.message, true);
        } finally {
          if (session === expectedSession) syncControls();
        }
      });
    }
  }

  async function load() {
    if (loading || sending || [...rows.values()].some(row => row.saving)) return;
    loading = true;
    refresh.disabled = true;
    const expectedSession = session;
    setFeedback('Caricamento utenti…');
    try {
      const result = await request({ action: 'list' });
      if (expectedSession !== session) return;
      draw(result.users || []);
      setFeedback(result.ready ? 'Le modifiche si salvano automaticamente.' : 'Servizio in attivazione.');
    } catch (error) {
      if (expectedSession === session) setFeedback(error.message || 'Impossibile caricare gli utenti.', true);
    } finally {
      if (session === expectedSession) {
        loading = false;
        syncControls();
      }
    }
  }

  async function updateStatus() {
    if (!isActive() || document.hidden || loading) return;
    const expectedSession = session;
    try {
      const result = await request({ action: 'status' });
      if (expectedSession !== session) return;
      for (const latest of result.users || []) {
        const row = rows.get(latest.uid);
        if (row && !row.saving) paint(row, latest);
      }
      syncControls();
    } catch (_) { /* A periodic refresh must not replace feedback from an explicit save. */ }
  }

  refresh.addEventListener('click', load);
  send?.addEventListener('click', async () => {
    if (send.disabled) return;
    const expectedSession = session;
    // Reuse the same request after an ambiguous network failure: one click intent,
    // one server ledger, even when the initial response never reaches the browser.
    if (!manualRequestId) manualRequestId = crypto.randomUUID();
    sending = true;
    syncControls();
    setFeedback('Preparazione del riepilogo…');
    try {
      const result = await request({ action: 'sendSummary', requestId: manualRequestId });
      if (session !== expectedSession) return;
      manualRequestId = '';
      for (const latest of result.users || []) {
        const row = rows.get(latest.uid);
        if (row) paint(row, latest);
      }
      setFeedback(result.alreadyQueued ? 'Riepilogo già richiesto. Controlla l’ultimo invio.' :
        'Riepilogo in invio a ' + result.queuedCount + (result.queuedCount === 1 ? ' utente.' : ' utenti.'));
    } catch (error) {
      if (session !== expectedSession) return;
      if (error.status && error.status < 500) manualRequestId = '';
      setFeedback(error.status ? error.message : 'Conferma di invio non ricevuta. Premi di nuovo Invia riepilogo.', true);
    } finally {
      if (session === expectedSession) {
        sending = false;
        syncControls();
      }
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isActive()) void updateStatus();
  });
  return {
    open() {
      const uid = getUser()?.uid || '';
      if (ownerUid !== uid) this.reset();
      ownerUid = uid;
      void load();
      if (!timer) timer = setInterval(updateStatus, 30000);
    },
    close() { if (timer) clearInterval(timer); timer = null; },
    reset() {
      session++;
      this.close();
      loading = false;
      sending = false;
      manualRequestId = '';
      ownerUid = '';
      rows.clear();
      list.replaceChildren();
      setFeedback('');
      syncControls();
    },
  };
}

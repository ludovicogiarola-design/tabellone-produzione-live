'use strict';

const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { createService } = require('./service');
const { PROJECT, REGION, TIME_ZONE } = require('./core');

initializeApp({ projectId: PROJECT });
const service = createService({
  db: getFirestore(), auth: getAuth(),
  scheduleRetry: async (data, options) => {
    // Only failed deliveries wait. This uses the existing Firestore event runtime:
    // no polling job, new queue, API enablement, or additional IAM grants.
    // Eventarc retries an interrupted invocation; the transaction checks the
    // original SMTP attempt so concurrent invocations cannot reset it twice.
    await new Promise(resolve => setTimeout(resolve, options.scheduleDelaySeconds * 1000));
    await service.retryEmail({ data });
  },
  logger,
});
const runtime = {
  region: REGION, memory: '256MiB', minInstances: 0, maxInstances: 3,
  serviceAccount: '537555699968-compute@developer.gserviceaccount.com',
};

exports.pickingEmailApi = onRequest({
  ...runtime, timeoutSeconds: 60,
  cors: ['https://' + PROJECT + '.web.app', 'https://' + PROJECT + '.firebaseapp.com'],
  invoker: 'public',
}, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo non consentito.' });
  if (req.rawBody?.length > 4096) return res.status(413).json({ error: 'Richiesta troppo grande.' });
  try {
    const result = await service.api(req.headers.authorization || '', req.body);
    return res.json(result);
  } catch (error) {
    if (!error.status) logger.error('picking_email_api_failed', { code: error.code, message: error.message });
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'Servizio momentaneamente non disponibile.' });
  }
});

exports.pickingEmailFba = onDocumentWritten({
  ...runtime, document: 'amzInventory/concamarise/logs/{flowId}', retry: true, timeoutSeconds: 120,
}, event => service.onNewWork(event, 'FBA'));

exports.pickingEmailFbmMorning = onSchedule({
  ...runtime, schedule: '0 8 * * *', timeZone: TIME_ZONE, timeoutSeconds: 180,
  retryCount: 3, minBackoffSeconds: 60, maxBackoffSeconds: 300, maxRetrySeconds: 3600,
}, event => service.onDaily(event));

exports.pickingEmailDelivery = onDocumentWritten({
  ...runtime, document: 'email/{mailId}', retry: true, timeoutSeconds: 420,
}, event => service.onDelivery(event));

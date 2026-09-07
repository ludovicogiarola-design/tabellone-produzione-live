# Picking: notifiche email e riepiloghi

Nel menu Notifiche l'amministratore seleziona gli account già registrati.
Nome, email e ultimo accesso provengono da Firebase Auth; gli inviti per email
e i documenti UID vengono ricondotti allo stesso account.
Ultimo accesso indica lastSignInTime, cioè l'ultima autenticazione dell'account.

## Invii

- FBA: email all'arrivo di ogni nuovo flusso operativo in
  amzInventory/concamarise/logs/{flowId}. Il registro dell'evento evita duplicati
  per risincronizzazioni, modifiche ordinarie e retry di Eventarc.
- FBM: riepilogo ogni giorno alle 08:00 Europe/Rome, con cambio automatico
  tra ora solare e legale. Nessun invio all'arrivo del singolo ordine FBM.
- Invia riepilogo: invio manuale ai soli utenti spuntati, con totali aggiornati
  di flussi FBA e ordini FBM ancora da evadere. Si può inviare anche con zero
  ordini. Il riepilogo giornaliero mostra entrambi i totali, anche se sono zero.
- Le email usano HTML e testo semplice. Grafica Picking verde #0f7078 e grigia,
  due totali e pulsante Apri Picking; il nuovo FBA include il suo riferimento.
- I conteggi leggono le fonti operative in una transazione. Escludono annullati,
  completati, prelevati e duplicati dei log Shopify. Per FBM si sottrae il
  maggiore tra shippedQty e inventoryAppliedQty; righe già azzerate non vengono
  recuperate dai vecchi dettagli dell'ordine.

## Accessi e affidabilità

Si riutilizzano la collezione email e l'estensione Firebase già attiva,
con mittente info@generalcoppersrl.com, senza nuove credenziali email.
Le collezioni pickingEmailConfig, pickingEmailRecipients, pickingEmailEvents e
pickingEmailDeliveries sono protette dalle regole Firestore default deny.
L'API verifica il token revocato e rilegge il flag isAdmin protetto dalle regole
per ogni richiesta. I campi liberi role/admin non conferiscono autorizzazioni.

Un utente disattivato, con email non verificata o cambiata dopo la selezione non
riceve avvisi. Le modifiche ai destinatari usano una revisione concorrente.
L'invio manuale accetta un identificatore univoco della richiesta, mantenuto dal
frontend anche quando la risposta di rete va persa; una transazione permette
un solo riepilogo per richiesta e un nuovo invio manuale al massimo al minuto.
I destinatari vengono sempre ricavati sul server, mai dal payload del browser.

L'ultimo invio viene aggiornato solo dopo SUCCESS, accettazione SMTP dell'email
prevista e delivery.endTime. Non indica la lettura da parte del lavoratore.
Per errori SMTP temporanei espliciti sono consentiti tre tentativi totali,
con attesa di 60 e poi 300 secondi nella funzione Eventarc esistente.
Esiti ambigui dopo DATA non vengono ritentati, per evitare invii duplicati.
I retry ricontrollano account, selezione e validità del riepilogo o flusso.
Gli invii per singolo FBM della versione precedente non vengono ritentati.

## Pianificazione e deploy

pickingEmailFbmMorning usa Cloud Scheduler, già attivo nel progetto:
cron 0 8 * * *, timeZone Europe/Rome, invocazione privata tramite l'identità
Compute esistente 537555699968-compute@developer.gserviceaccount.com.
Non vengono creati service account o assegnati ruoli a livello di progetto.
La chiave DAILY_FBM:data-italiana evita duplicati, anche con job concorrenti.
Le esecuzioni fuori orario o troppo vecchie vengono ignorate. Il destinatario
deve essere già selezionato all'ora prevista; non vengono inviati arretrati.

Il timestamp activatedAt in pickingEmailConfig/system è preservato.
Per aggiornare questo solo codebase e rimuovere il vecchio trigger per ordine:

    firebase deploy --only functions:picking-notifications --project tabellone-produzione-liv-e313e --non-interactive --force

Funzioni finali: pickingEmailApi, pickingEmailFba, pickingEmailDelivery,
pickingEmailFbmMorning. pickingEmailFbm viene eliminata come richiesto.
Hosting viene pubblicato dal workflow esistente dopo un unico push su main.

## Verifica

    npm test

Con Firestore Emulator attivo esclusivamente su 127.0.0.1:8791:

    FIRESTORE_EMULATOR_HOST=127.0.0.1:8791 npm test

I test di integrazione usano solo demo-picking-email-tests. Coprono selezione,
accessi, riepiloghi manuali, deduplicazione, orario italiano, retry e ultimo
invio confermato. Nessuna email di prova viene spedita ai lavoratori.

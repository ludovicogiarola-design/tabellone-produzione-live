# Picking: email per nuovi FBA e FBM

Nel menu Notifiche l'amministratore seleziona gli utenti abilitati, già registrati
in Firebase Auth. Email e nome provengono dall'account; gli inviti per email e i
documenti UID vengono ricondotti allo stesso account. Nessun destinatario viene
attivato automaticamente.

## Flusso

- FBA: prima comparsa di un flusso operativo in
  amzInventory/concamarise/logs/{flowId}.
- FBM: prima comparsa di un ordine attivo con righe da preparare in
  shopifyFbmOrders/{orderId}. I log Shopify di magazzino non duplicano l'avviso.
- Una transazione crea il registro dell'evento e una singola email per ogni UID
  selezionato. Le risincronizzazioni e le consegne duplicate di Eventarc vengono
  deduplicate tramite un identificatore stabile.
- Viene riutilizzata la collezione email dell'estensione Firebase già attiva,
  con mittente info@generalcoppersrl.com. Non sono necessari nuovi provider,
  segreti, API, code o permessi IAM.
- L'interfaccia legge l'ora dell'ultimo invio da delivery.endTime, solo dopo
  SUCCESS e conferma SMTP dell'indirizzo previsto. Questo conferma
  l'accettazione da parte del server email, non la lettura del lavoratore.

## Accessi e gestione errori

Le nuove collezioni pickingEmailConfig, pickingEmailRecipients,
pickingEmailEvents e pickingEmailDeliveries sono protette dal default deny
delle regole Firestore esistenti. Il frontend usa soltanto l'API autenticata:
il flag isAdmin protetto dalle regole viene riletto sul server a ogni richiesta.
I campi liberi del profilo, come role/admin, non conferiscono autorizzazioni.

Il backend usa l'identità già utilizzata dalle funzioni email del Tabellone,
537555699968-compute@developer.gserviceaccount.com; non modifica le policy IAM.

Un utente disattivato, con email non verificata o cambiata dopo la selezione non
riceve avvisi. Le modifiche alla selezione usano una revisione per evitare
sovrascritture da schermate obsolete.

Per errori SMTP temporanei espliciti o errori prima della connessione, la
funzione di consegna attende 60 secondi e poi 300 secondi: massimo tre tentativi
SMTP totali. Durante l'attesa il frontend non deve rimanere aperto. La
transazione ricontrolla destinatario, revisione, ordine e tentativo corrente.
Le interruzioni dell'esecuzione vengono riprese tramite retry di Eventarc.
Gli esiti ambigui dopo DATA non vengono ritentati automaticamente per evitare
email duplicate e sono mostrati come esito da verificare.

## Attivazione e deploy

Il documento server pickingEmailConfig/system contiene activatedAt, impostato
una sola volta durante l'attivazione. Il backend esclude gli ordini precedenti
all'attivazione e quelli arrivati prima della selezione del destinatario.

I sorgenti sono nel codebase Firebase picking-notifications.
Il deploy delle sole quattro funzioni è:

    firebase deploy --only functions:picking-notifications --project tabellone-produzione-liv-e313e --non-interactive

Al primo deploy aggiungere --force per confermare la policy di retry idempotente
delle tre funzioni Firestore. Il comando rimane limitato a questo codebase.

Hosting viene pubblicato dal workflow già presente dopo il push su main.
Non eseguire un deploy globale di tutte le funzioni del progetto.

## Verifica

npm test esegue i test di classificazione, autorizzazione e politiche di retry.
Con Firestore Emulator attivo su 127.0.0.1:8791:

    FIRESTORE_EMULATOR_HOST=127.0.0.1:8791 npm test

I test di integrazione usano esclusivamente il progetto
demo-picking-email-tests. Coprono transazioni concorrenti, annullamenti,
selezioni obsolete, utenti disattivati, conferma invio e callback duplicate.
Nessuna email di prova viene inviata ai lavoratori.

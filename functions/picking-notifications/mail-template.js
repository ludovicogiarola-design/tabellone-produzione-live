'use strict';

const textValue = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
const htmlValue = value => textValue(value).replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const quantity = value => new Intl.NumberFormat('it-IT').format(value);
const count = (n, one, many) => quantity(n) + ' ' + (n === 1 ? one : many);

function buildSubject(details) {
  const { fba, fbm } = details;
  const parts = [];
  if (fba.totalQty) parts.push('FBA urgente: ' + count(fba.totalQty, 'pezzo', 'pezzi'));
  if (fbm.orderCount) parts.push('FBM: ' + count(fbm.orderCount, 'ordine', 'ordini'));
  if (!parts.length) return 'Picking Concamarise | Nessun prodotto da preparare';
  const summary = parts.join(' | ');
  const channels = [fba.totalQty ? 'FBA urgente' : '', fbm.orderCount ? 'ordini FBM' : ''].filter(Boolean);
  // The subject stays within 100 characters, even for unusually large totals.
  // Use complete alternatives instead of cutting a word or quantity in half.
  return ['Picking Concamarise | ' + summary, 'Picking | ' + summary,
    'Picking | ' + channels.join(' e ') + ' da preparare'].find(value => value.length <= 100);
}

function renderMessage({ type = 'manual', label = '', details, recipientName = '', generatedAt = Date.now(), url, timeZone }) {
  const { fba, fbm } = details;
  const priority = fba.totalQty > 0, hasWork = priority || fbm.totalQty > 0;
  const subject = buildSubject(details);
  const title = priority ? 'Procedere all’evasione FBA' : hasWork ? 'Ordini FBM da evadere' : 'Nessun prodotto da preparare';
  const notice = type === 'daily' ? 'AVVISO OPERATIVO · ORE 08:00' : 'AVVISO OPERATIVO';
  const place = 'Stabilimento LG Trading SRL di Concamarise';
  const assignee = textValue(recipientName).slice(0, 180);
  const date = new Intl.DateTimeFormat('it-IT', { timeZone, day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(generatedAt));
  const urgency = 'Amazon in arrivo per il carico';
  const instruction = priority ? 'Preparare con priorità i prodotti FBA e tenere la merce pronta per il ritiro Amazon.' :
    hasWork ? 'Procedere alla preparazione degli ordini FBM riportati di seguito.' : 'Al momento non risultano prodotti da prelevare.';
  const steps = hasWork ? [
    'Aprire Picking e consultare le preparazioni da evadere.',
    'Prelevare i prodotti nello stabilimento di Concamarise e controllare SKU e quantità.',
    ...(priority ? ['Raggruppare la merce FBA per spedizione e predisporla per il carico Amazon.'] : []),
    ...(fbm.totalQty ? [priority ? 'Preparare poi gli ordini FBM, mantenendoli separati per numero ordine.' :
      'Preparare gli ordini FBM, mantenendoli separati per numero ordine.'] : []),
    'Registrare in Picking i prelievi completati.',
  ] : [];

  const mainChannel = priority ? 'FBA' : 'FBM';
  const openUrl = channel => url + '?picking=' + channel.toLowerCase();
  const button = `<table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#ffd814" style="background:#ffd814;border:1px solid #f0c14b;border-radius:3px;text-align:center"><a href="${openUrl(mainChannel)}" style="display:inline-block;padding:11px 24px;color:#0f1111;font-size:14px;line-height:20px;font-weight:700;text-decoration:none">Apri Picking ${mainChannel}</a></td></tr></table>`;

  function productsHtml(channel, data) {
    if (!data.products.length) return '';
    const reference = data.orderCount === 1 ? data.products[0].references[0]?.label : '';
    const singleReference = reference === 'Preparazione FBA' ? '' : reference;
    const rows = data.products.map(p => `<tr>
<td style="padding:13px 12px 13px 0;border-bottom:1px solid #d5d9d9;vertical-align:top"><div style="font-size:15px;line-height:1.5;color:#0f1111;overflow-wrap:anywhere;word-break:break-word">${htmlValue(p.title || p.sku)}</div>${p.title ? '<div style="margin-top:4px;font-size:13px;line-height:1.5;color:#565959;overflow-wrap:anywhere;word-break:break-word">SKU: ' + htmlValue(p.sku) + '</div>' : ''}${data.orderCount > 1 ? '<div style="margin-top:5px;font-size:13px;line-height:1.55;color:#565959">' + p.references.map(r => htmlValue(r.label) + ': <strong>' + quantity(r.qty) + ' pz</strong>').join('<br>') + '</div>' : ''}</td>
<td align="right" style="width:74px;padding:13px 0;border-bottom:1px solid #d5d9d9;vertical-align:top;color:#0f1111;font-size:15px;line-height:1.5;font-weight:700">${quantity(p.qty)} pz</td></tr>`).join('');
    return `<tr><td class="content" style="padding:26px 28px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td><h2 style="margin:0;color:#0f1111;font-size:18px;line-height:1.4;font-weight:700">Prodotti ${channel} da preparare</h2></td>${channel !== mainChannel ? '<td align="right" style="padding-left:12px"><a href="' + openUrl(channel) + '" style="color:#005b70;font-size:14px;line-height:1.5;text-decoration:underline">Apri Picking ' + channel + '</a></td>' : ''}</tr></table>
${singleReference ? '<p style="margin:5px 0 0;color:#565959;font-size:13px;line-height:1.5">' + (channel === 'FBA' ? 'Spedizione ' : 'Ordine ') + htmlValue(singleReference) + '</p>' : ''}
<table aria-label="Prodotti ${channel} da preparare" width="100%" cellspacing="0" cellpadding="0" style="margin-top:12px;border-collapse:collapse"><thead><tr><th scope="col" align="left" style="padding:9px 12px 9px 0;border-bottom:1px solid #a2a6ac;color:#565959;font-size:13px;font-weight:400">Prodotto / SKU</th><th scope="col" align="right" style="width:74px;padding:9px 0;border-bottom:1px solid #a2a6ac;color:#565959;font-size:13px;font-weight:400">Quantità</th></tr></thead><tbody>${rows}</tbody></table>
</td></tr>`;
  }

  function productsText(channel, data) {
    if (!data.products.length) return [channel + ': nessun prodotto da preparare.'];
    return ['PRODOTTI ' + channel + ' DA PREPARARE', count(data.totalQty, 'pezzo', 'pezzi') + ' · ' +
      count(data.skuCount, 'prodotto', 'prodotti') + (channel === 'FBM' ? ' · ' + count(data.orderCount, 'ordine', 'ordini') : ''),
      ...data.products.flatMap(p => [
        '- ' + textValue(p.title || p.sku) + ' | SKU: ' + textValue(p.sku) + ' | ' + quantity(p.qty) + ' pezzi',
        ...p.references.map(r => '  ' + textValue(r.label) + ': ' + quantity(r.qty) + ' pezzi'),
      ]), 'Apri Picking ' + channel + ': ' + url + '?picking=' + channel.toLowerCase()];
  }

  const text = [notice, 'LG Trading SRL · Picking', title, ...(assignee ? ['Incaricato: ' + assignee] : []),
    'Luogo di lavoro: ' + place, date, '',
    ...(priority ? [urgency] : []), instruction,
    ...(type === 'fba' && label ? ['Spedizione appena inserita: ' + textValue(label)] : []), '',
    'Totale FBA: ' + count(fba.totalQty, 'pezzo', 'pezzi') + ' · ' + count(fba.skuCount, 'prodotto', 'prodotti'),
    'Totale FBM: ' + count(fbm.orderCount, 'ordine', 'ordini') + ' · ' + count(fbm.totalQty, 'pezzo', 'pezzi') + ' · ' + count(fbm.skuCount, 'prodotto', 'prodotti'), '',
    ...(steps.length ? ['PROCEDURA', ...steps.map((s, i) => (i + 1) + '. ' + s), ''] : []),
    ...productsText('FBA', fba), '', ...productsText('FBM', fbm),
  ].join('\n');
  const stepsHtml = steps.map(s => '<li style="padding:0 0 7px;color:#0f1111;font-size:14px;line-height:1.6">' + htmlValue(s) + '</li>').join('');
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${htmlValue(subject)}</title><style>:root{color-scheme:light;supported-color-schemes:light}@media screen and (max-width:480px){.content{padding-left:16px!important;padding-right:16px!important}.message-title{font-size:22px!important}}</style></head>
<body style="margin:0;padding:0;background:#ffffff;color:#0f1111;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#ffffff"><tr><td align="center" style="padding:12px 0 24px">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" bgcolor="#ffffff" style="width:100%;max-width:640px;background:#ffffff;color:#0f1111;font-family:Arial,Helvetica,sans-serif">
<tr><td class="content" style="padding:16px 28px 18px;border-bottom:1px solid #d5d9d9"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td valign="top" style="color:#232f3e;font-size:24px;line-height:1.2;font-weight:700">Picking<div style="padding-top:5px;color:#565959;font-size:13px;line-height:1.4;font-weight:400">LG Trading SRL</div></td><td align="right" valign="top" style="padding-left:12px;color:#565959;font-size:13px;line-height:1.6">${notice}<br>${htmlValue(date)}</td></tr></table></td></tr>
<tr><td class="content" style="padding:24px 28px 0"><h1 class="message-title" style="margin:0;color:#0f1111;font-size:24px;line-height:1.3;font-weight:400">${title}</h1>
${assignee ? '<p style="margin:16px 0 0;color:#0f1111;font-size:16px;line-height:1.5;overflow-wrap:anywhere;word-break:break-word"><strong>Incaricato: ' + htmlValue(assignee) + '</strong></p>' : ''}
<p style="margin:7px 0 0;color:#565959;font-size:14px;line-height:1.6"><strong>Luogo di lavoro:</strong> ${place}</p>
${priority ? '<p style="margin:18px 0 0;color:#0f1111;font-size:16px;line-height:1.5;font-weight:700">' + urgency + '</p>' : ''}
<p style="margin:8px 0 0;color:#0f1111;font-size:15px;line-height:1.6">${instruction}</p>
${type === 'fba' && label && label !== 'Preparazione FBA' ? '<p style="margin:8px 0 0;color:#565959;font-size:14px;line-height:1.5">Nuova spedizione: <strong style="color:#0f1111">' + htmlValue(label) + '</strong></p>' : ''}
${hasWork ? '<div style="padding-top:18px">' + button + '</div>' : ''}
</td></tr>
<tr><td class="content" style="padding:24px 28px 0"><h2 style="margin:0 0 10px;color:#0f1111;font-size:16px;line-height:1.5;font-weight:700">Riepilogo da evadere</h2>
<table aria-label="Riepilogo FBA e FBM" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;color:#0f1111;font-size:14px;line-height:1.5"><thead><tr bgcolor="#f0f2f2"><th scope="col" align="left" style="padding:9px 10px;border-top:1px solid #d5d9d9;border-bottom:1px solid #d5d9d9;color:#565959;font-size:13px;font-weight:400">Canale</th><th scope="col" align="right" style="padding:9px 10px;border-top:1px solid #d5d9d9;border-bottom:1px solid #d5d9d9;color:#565959;font-size:13px;font-weight:400">Pezzi</th><th scope="col" align="right" style="padding:9px 10px;border-top:1px solid #d5d9d9;border-bottom:1px solid #d5d9d9;color:#565959;font-size:13px;font-weight:400">Prodotti (SKU)</th></tr></thead><tbody>
<tr><th scope="row" align="left" style="padding:11px 10px;border-bottom:1px solid #d5d9d9;font-weight:400"><strong>FBA</strong>${priority ? ' · Priorità' : ''}</th><td align="right" style="padding:11px 10px;border-bottom:1px solid #d5d9d9;font-weight:700">${quantity(fba.totalQty)}</td><td align="right" style="padding:11px 10px;border-bottom:1px solid #d5d9d9">${quantity(fba.skuCount)}</td></tr>
<tr><th scope="row" align="left" style="padding:11px 10px;border-bottom:1px solid #d5d9d9;font-weight:400"><strong>FBM</strong> · ${count(fbm.orderCount, 'ordine', 'ordini')}</th><td align="right" style="padding:11px 10px;border-bottom:1px solid #d5d9d9;font-weight:700">${quantity(fbm.totalQty)}</td><td align="right" style="padding:11px 10px;border-bottom:1px solid #d5d9d9">${quantity(fbm.skuCount)}</td></tr>
</tbody></table></td></tr>
${productsHtml('FBA', fba)}${productsHtml('FBM', fbm)}
${steps.length ? '<tr><td class="content" style="padding:26px 28px 0"><h2 style="margin:0 0 12px;color:#0f1111;font-size:16px;line-height:1.5;font-weight:700">Procedura da seguire</h2><ol style="margin:0;padding-left:21px;color:#0f1111;font-size:14px;line-height:1.6">' + stepsHtml + '</ol></td></tr>' : ''}
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

module.exports = { renderMessage };

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

function renderMessage({ type = 'manual', label = '', details, generatedAt = Date.now(), url, timeZone }) {
  const { fba, fbm } = details;
  const priority = fba.totalQty > 0, hasWork = priority || fbm.totalQty > 0;
  const subject = buildSubject(details);
  const title = priority ? 'Procedere all’evasione FBA' : hasWork ? 'Ordini FBM da evadere' : 'Nessun prodotto da preparare';
  const notice = type === 'daily' ? 'AVVISO OPERATIVO · ORE 08:00' : 'AVVISO OPERATIVO';
  const place = 'Stabilimento LG Trading SRL di Concamarise';
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

  const button = (channel, secondary = false) => `<table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="${secondary ? '#ffffff' : '#e6f2ed'}" style="border:1px solid ${secondary ? '#a9b9b5' : '#0f7078'};border-radius:9px"><a href="${url}?picking=${channel.toLowerCase()}" style="display:inline-block;padding:13px 21px;color:#003c41;font-size:15px;font-weight:700;text-decoration:none">Apri Picking ${channel}</a></td></tr></table>`;

  function productsHtml(channel, data) {
    if (!data.products.length) return '';
    const singleReference = data.orderCount === 1 ? data.products[0].references[0]?.label : '';
    const rows = data.products.map((p, i) => `<tr>
<td style="padding:15px 12px;border-top:1px solid #e2e8f0;vertical-align:top;background:${i % 2 ? '#f8faf9' : '#ffffff'}"><div style="font-size:15px;line-height:1.45;font-weight:700;color:#0f172a;overflow-wrap:anywhere">${htmlValue(p.title || p.sku)}</div>${p.title ? '<div style="margin-top:5px;font-size:13px;line-height:1.5;color:#475569;font-family:Consolas,monospace">SKU: ' + htmlValue(p.sku) + '</div>' : ''}${data.orderCount > 1 ? '<div style="margin-top:7px;font-size:13px;line-height:1.55;color:#475569">' + p.references.map(r => htmlValue(r.label) + ': <strong>' + quantity(r.qty) + ' pz</strong>').join('<br>') + '</div>' : ''}</td>
<td align="right" style="width:75px;padding:15px 12px;border-top:1px solid #e2e8f0;vertical-align:top;background:${i % 2 ? '#f8faf9' : '#ffffff'}"><span style="display:inline-block;padding:6px 10px;border-radius:8px;background:#eef7f4;color:#003c41;font-size:18px;font-weight:700;white-space:nowrap">${quantity(p.qty)}</span><div style="margin-top:5px;font-size:13px;color:#475569">pezzi</div></td></tr>`).join('');
    return `<tr><td class="content" style="padding:26px 28px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding-bottom:12px"><h2 style="margin:0;font-size:20px;line-height:1.3;color:#003c41">Prodotti ${channel} da preparare</h2><div style="margin-top:5px;font-size:13px;line-height:1.5;color:#475569">${count(data.totalQty, 'pezzo', 'pezzi')} · ${count(data.skuCount, 'prodotto', 'prodotti')}${channel === 'FBM' ? ' · ' + count(data.orderCount, 'ordine', 'ordini') : ''}${singleReference ? '<br>' + (channel === 'FBA' ? 'Spedizione ' : 'Ordine ') + htmlValue(singleReference) : ''}</div></td></tr></table>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e2e8f0;border-radius:10px;border-spacing:0"><tr><td style="padding:10px 12px;background:#f0f4f2;color:#475569;font-size:13px;letter-spacing:.6px;font-weight:700">PRODOTTO / SKU</td><td align="right" style="padding:10px 12px;background:#f0f4f2;color:#475569;font-size:13px;font-weight:700">QUANTITÀ</td></tr>${rows}</table>
<div style="padding-top:16px">${button(channel, channel === 'FBM' && priority)}</div></td></tr>`;
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

  const text = [notice, 'LG Trading SRL · Picking', title, 'Luogo di lavoro: ' + place, date, '',
    ...(priority ? [urgency] : []), instruction,
    ...(type === 'fba' && label ? ['Spedizione appena inserita: ' + textValue(label)] : []), '',
    'Totale FBA: ' + count(fba.totalQty, 'pezzo', 'pezzi') + ' · ' + count(fba.skuCount, 'prodotto', 'prodotti'),
    'Totale FBM: ' + count(fbm.orderCount, 'ordine', 'ordini') + ' · ' + count(fbm.totalQty, 'pezzo', 'pezzi') + ' · ' + count(fbm.skuCount, 'prodotto', 'prodotti'), '',
    ...(steps.length ? ['PROCEDURA', ...steps.map((s, i) => (i + 1) + '. ' + s), ''] : []),
    ...productsText('FBA', fba), '', ...productsText('FBM', fbm),
  ].join('\n');
  const stepRows = steps.map((s, i) => `<tr><td valign="top" style="width:24px;padding:0 12px 12px 0"><div style="width:23px;line-height:23px;text-align:center;border-radius:7px;background:#eef7f4;color:#07534c;font-size:13px;font-weight:700">${i + 1}</div></td><td style="padding:0 0 12px;vertical-align:top;font-size:15px;line-height:1.5;color:#334155">${htmlValue(s)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${htmlValue(subject)}</title><style>:root{color-scheme:light;supported-color-schemes:light}@media screen and (max-width:480px){.content{padding-left:16px!important;padding-right:16px!important}.hero-title{font-size:25px!important}}</style></head>
<body style="margin:0;padding:0;background:#f3f5f4;color:#0f172a;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f3f5f4"><tr><td align="center" style="padding:24px 10px">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" bgcolor="#ffffff" style="width:100%;max-width:640px;background:#ffffff;border:1px solid #dce5e7;border-radius:18px;overflow:hidden">
<tr><td class="content" bgcolor="#eef7f4" style="padding:27px 28px 30px;background:#eef7f4;border-top:4px solid #0f7078;border-radius:17px 17px 0 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="color:#003c41;font-size:26px;font-weight:800;letter-spacing:-.7px">Picking<div style="margin-top:4px;color:#07534c;font-size:13px;font-weight:600;letter-spacing:1px">LG TRADING SRL</div></td><td align="right" valign="top" style="padding-top:5px;color:#475569;font-size:13px;line-height:1.5">${htmlValue(date)}</td></tr></table>
<div style="margin-top:28px;color:#07534c;font-size:13px;font-weight:700;letter-spacing:1px">${notice}</div><h1 class="hero-title" style="margin:9px 0 12px;color:#003c41;font-size:30px;font-weight:700;line-height:1.2;letter-spacing:-.6px">${title}</h1><div style="color:#334155;font-size:15px;line-height:1.5">${place}</div></td></tr>
<tr><td class="content" style="padding:24px 28px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:16px 18px;background:${priority ? '#eef7f4' : '#f5f7f6'};border-left:4px solid #0f7078;border-radius:8px"><div style="font-size:16px;line-height:1.4;font-weight:700;color:#003c41">${priority ? urgency : hasWork ? 'Procedere all’evasione' : 'Situazione aggiornata'}</div><div style="margin-top:6px;font-size:15px;line-height:1.6;color:#334155">${instruction}</div>${type === 'fba' && label ? '<div style="margin-top:9px;font-size:13px;line-height:1.5;color:#07534c">Spedizione appena inserita: <strong>' + htmlValue(label) + '</strong></div>' : ''}</td></tr></table></td></tr>
<tr><td class="content" style="padding:20px 28px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
<td width="48%" valign="top" style="padding:18px 14px;background:#eef7f4;border:1px solid #d5e8e9;border-radius:10px"><div style="color:#07534c;font-size:13px;font-weight:700">TOTALE FBA</div><div style="margin:10px 0 5px;font-size:38px;line-height:1.1;font-weight:700;color:#003c41">${quantity(fba.totalQty)}</div><div style="font-size:13px;line-height:1.5;color:#334155">pezzi da preparare</div><div style="margin-top:9px;font-size:13px;color:#07534c">${count(fba.skuCount, 'prodotto', 'prodotti')} (SKU)</div></td><td width="4%"></td>
<td width="48%" valign="top" style="padding:18px 14px;background:#f5f7f6;border:1px solid #e2e8f0;border-radius:10px"><div style="color:#475569;font-size:13px;font-weight:700">TOTALE FBM</div><div style="margin:10px 0 5px;font-size:38px;line-height:1.1;font-weight:700;color:#0f172a">${quantity(fbm.orderCount)}</div><div style="font-size:13px;line-height:1.5;color:#334155">ordini da evadere</div><div style="margin-top:9px;font-size:13px;line-height:1.5;color:#475569">${count(fbm.totalQty, 'pezzo', 'pezzi')} · ${count(fbm.skuCount, 'prodotto', 'prodotti')}</div></td>
</tr></table></td></tr>
${steps.length ? '<tr><td class="content" style="padding:25px 28px 0"><h2 style="margin:0 0 16px;color:#003c41;font-size:18px">Procedura da seguire</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0">' + stepRows + '</table></td></tr>' : ''}
${productsHtml('FBA', fba)}${productsHtml('FBM', fbm)}
<tr><td class="content" style="padding:28px"><div style="padding-top:18px;border-top:1px solid #e2e8f0;color:#475569;font-size:13px;line-height:1.5"><strong style="color:#475569">Luogo di lavoro</strong><br>${place}</div></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

module.exports = { renderMessage };

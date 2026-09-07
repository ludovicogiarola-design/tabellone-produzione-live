'use strict';

const textValue = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
const htmlValue = value => textValue(value).replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const quantity = value => new Intl.NumberFormat('it-IT').format(value);
const count = (n, one, many) => quantity(n) + ' ' + (n === 1 ? one : many);

function shortName(product) {
  const title = textValue(product.title || product.sku);
  const name = title.split(/\s+[–—|]\s+|\s+-\s+/)[0].replace(/^Bionee\s+/i, '');
  const short = name.length > 45 ? name.slice(0, 42).trimEnd() + '…' : name;
  const size = title.match(/\b\d+(?:[.,]\d+)?\s*(?:kg|ml|litri|litro|lt|g|l)\b/i)?.[0];
  return size && !short.toLowerCase().includes(size.toLowerCase()) ? short + ' (' + size + ')' : short;
}

function buildSubject(details) {
  const { fba, fbm } = details;
  const parts = [];
  if (fba.totalQty) parts.push('FBA URGENTE: ' + count(fba.totalQty, 'pezzo', 'pezzi') + ' / ' + count(fba.skuCount, 'prodotto', 'prodotti'));
  if (fbm.orderCount) parts.push('FBM: ' + count(fbm.orderCount, 'ordine', 'ordini') + ' / ' + count(fbm.totalQty, 'pezzo', 'pezzi'));
  if (!parts.length) return 'Picking Concamarise | Nessun prodotto da preparare';
  parts.push(fba.totalQty ? 'Concamarise - Amazon in arrivo per il carico' : 'Picking Concamarise - Procedere all’evasione');
  let subject = parts.join(' | ');
  const products = [
    ...fba.products.map(p => ({ ...p, channel: 'FBA' })),
    ...fbm.products.map(p => ({ ...p, channel: 'FBM' })),
  ];
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const sku = p.title && p.title !== p.sku ? ' [' + textValue(p.sku) + ']' : '';
    const item = p.channel + ' ' + shortName(p) + sku + ': ' + quantity(p.qty) + ' pz';
    // Keep a usable mail header for large batches. The body always contains every
    // product and every allocation; the subject explicitly counts omitted entries.
    if (Buffer.byteLength(subject + ' | ' + item, 'utf8') > 800) {
      subject += ' | +' + (products.length - i) + ' prodotti: dettagli nella mail';
      break;
    }
    subject += ' | ' + item;
  }
  return subject;
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

  const button = (channel, secondary = false) => `<table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="${secondary ? '#ffffff' : '#0f7078'}" style="border:1px solid ${secondary ? '#cbd5e1' : '#0f7078'};border-radius:9px"><a href="${url}?picking=${channel.toLowerCase()}" style="display:inline-block;padding:13px 21px;color:${secondary ? '#003c41' : '#ffffff'};font-size:14px;font-weight:700;text-decoration:none">Apri Picking ${channel}</a></td></tr></table>`;

  function productsHtml(channel, data) {
    if (!data.products.length) return '';
    const singleReference = data.orderCount === 1 ? data.products[0].references[0]?.label : '';
    const rows = data.products.map((p, i) => `<tr>
<td style="padding:15px 12px;border-top:1px solid #e2e8f0;vertical-align:top;background:${i % 2 ? '#f8fafb' : '#ffffff'}"><div style="font-size:14px;line-height:1.45;font-weight:700;color:#0f172a;overflow-wrap:anywhere">${htmlValue(p.title || p.sku)}</div>${p.title ? '<div style="margin-top:5px;font-size:11px;line-height:1.5;color:#64748b;font-family:Consolas,monospace">SKU: ' + htmlValue(p.sku) + '</div>' : ''}${data.orderCount > 1 ? '<div style="margin-top:7px;font-size:12px;line-height:1.55;color:#475569">' + p.references.map(r => htmlValue(r.label) + ': <strong>' + quantity(r.qty) + ' pz</strong>').join('<br>') + '</div>' : ''}</td>
<td align="right" style="width:75px;padding:15px 12px;border-top:1px solid #e2e8f0;vertical-align:top;background:${i % 2 ? '#f8fafb' : '#ffffff'}"><span style="display:inline-block;padding:6px 10px;border-radius:8px;background:#eef7f8;color:#003c41;font-size:18px;font-weight:700;white-space:nowrap">${quantity(p.qty)}</span><div style="margin-top:5px;font-size:11px;color:#64748b">pezzi</div></td></tr>`).join('');
    return `<tr><td class="content" style="padding:26px 28px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding-bottom:12px"><h2 style="margin:0;font-size:20px;line-height:1.3;color:#003c41">Prodotti ${channel} da preparare</h2><div style="margin-top:5px;font-size:13px;line-height:1.5;color:#64748b">${count(data.totalQty, 'pezzo', 'pezzi')} · ${count(data.skuCount, 'prodotto', 'prodotti')}${channel === 'FBM' ? ' · ' + count(data.orderCount, 'ordine', 'ordini') : ''}${singleReference ? '<br>' + (channel === 'FBA' ? 'Spedizione ' : 'Ordine ') + htmlValue(singleReference) : ''}</div></td></tr></table>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e2e8f0;border-radius:10px;border-spacing:0"><tr><td style="padding:10px 12px;background:#f1f5f6;color:#64748b;font-size:10px;letter-spacing:.6px;font-weight:700">PRODOTTO / SKU</td><td align="right" style="padding:10px 12px;background:#f1f5f6;color:#64748b;font-size:10px;font-weight:700">QUANTITÀ</td></tr>${rows}</table>
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
  const stepRows = steps.map((s, i) => `<tr><td valign="top" style="width:24px;padding:0 12px 12px 0"><div style="width:23px;line-height:23px;text-align:center;border-radius:7px;background:#eef7f8;color:#0f7078;font-size:12px;font-weight:700">${i + 1}</div></td><td style="padding:0 0 12px;vertical-align:top;font-size:14px;line-height:1.5;color:#334155">${htmlValue(s)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlValue(subject)}</title><style>@media screen and (max-width:480px){.content{padding-left:16px!important;padding-right:16px!important}.hero-title{font-size:25px!important}}</style></head>
<body style="margin:0;padding:0;background:#f1f4f5;color:#0f172a;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f1f4f5"><tr><td align="center" style="padding:24px 10px">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#ffffff;border:1px solid #dce5e7;border-radius:18px;overflow:hidden">
<tr><td class="content" bgcolor="#003c41" style="padding:27px 28px 30px;background:#003c41;background-image:linear-gradient(125deg,#003c41,#0f7078);border-radius:17px 17px 0 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="color:#ffffff;font-size:26px;font-weight:800;letter-spacing:-.7px">Picking<div style="margin-top:4px;color:#c5e4e4;font-size:11px;font-weight:600;letter-spacing:1px">LG TRADING SRL</div></td><td align="right" valign="top" style="padding-top:5px;color:#d4e9e9;font-size:12px;line-height:1.5">${htmlValue(date)}</td></tr></table>
<div style="margin-top:28px;color:#bee8e4;font-size:11px;font-weight:700;letter-spacing:1px">${notice}</div><h1 class="hero-title" style="margin:9px 0 12px;color:#ffffff;font-size:30px;font-weight:700;line-height:1.2;letter-spacing:-.6px">${title}</h1><div style="color:#e1eeee;font-size:14px;line-height:1.5">${place}</div></td></tr>
<tr><td class="content" style="padding:24px 28px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:16px 18px;background:${priority ? '#eef7f8' : '#f6f7f9'};border-left:4px solid #0f7078;border-radius:8px"><div style="font-size:16px;line-height:1.4;font-weight:700;color:#003c41">${priority ? urgency : hasWork ? 'Procedere all’evasione' : 'Situazione aggiornata'}</div><div style="margin-top:6px;font-size:14px;line-height:1.6;color:#334155">${instruction}</div>${type === 'fba' && label ? '<div style="margin-top:9px;font-size:12px;line-height:1.5;color:#0f7078">Spedizione appena inserita: <strong>' + htmlValue(label) + '</strong></div>' : ''}</td></tr></table></td></tr>
<tr><td class="content" style="padding:20px 28px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
<td width="48%" valign="top" style="padding:18px 14px;background:#eef7f8;border:1px solid #d5e8e9;border-radius:10px"><div style="color:#0f7078;font-size:12px;font-weight:700">TOTALE FBA</div><div style="margin:10px 0 5px;font-size:38px;line-height:1.1;font-weight:700;color:#003c41">${quantity(fba.totalQty)}</div><div style="font-size:13px;line-height:1.5;color:#334155">pezzi da preparare</div><div style="margin-top:9px;font-size:12px;color:#0f7078">${count(fba.skuCount, 'prodotto', 'prodotti')} (SKU)</div></td><td width="4%"></td>
<td width="48%" valign="top" style="padding:18px 14px;background:#f6f7f9;border:1px solid #e2e8f0;border-radius:10px"><div style="color:#475569;font-size:12px;font-weight:700">TOTALE FBM</div><div style="margin:10px 0 5px;font-size:38px;line-height:1.1;font-weight:700;color:#0f172a">${quantity(fbm.orderCount)}</div><div style="font-size:13px;line-height:1.5;color:#334155">ordini da evadere</div><div style="margin-top:9px;font-size:12px;line-height:1.5;color:#475569">${count(fbm.totalQty, 'pezzo', 'pezzi')} · ${count(fbm.skuCount, 'prodotto', 'prodotti')}</div></td>
</tr></table></td></tr>
${steps.length ? '<tr><td class="content" style="padding:25px 28px 0"><h2 style="margin:0 0 16px;color:#003c41;font-size:18px">Procedura da seguire</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0">' + stepRows + '</table></td></tr>' : ''}
${productsHtml('FBA', fba)}${productsHtml('FBM', fbm)}
<tr><td class="content" style="padding:28px"><div style="padding-top:18px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.5"><strong style="color:#475569">Luogo di lavoro</strong><br>${place}</div></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

module.exports = { renderMessage };

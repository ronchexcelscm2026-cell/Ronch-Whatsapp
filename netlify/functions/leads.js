'use strict';
/*
  Lead list for the WhatsApp bot.  Open https://<your-site>/leads
  Protected by the LEADS_PASSWORD environment variable.
  Shows every visitor who messaged the bot, newest first, with a CSV download.
*/

const crypto = require('crypto');
const { connectLambda, getStore } = require('@netlify/blobs');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ist = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '';

function passwordOk(given) {
  const real = (process.env.LEADS_PASSWORD || '').trim();
  if (!real || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>WhatsApp Leads</title>
<style>
  body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#1b2a33;background:#f3f6f8}
  main{max-width:1100px;margin:0 auto;padding:20px 16px}
  h1{color:#01517E;font-size:22px;margin:0 0 4px}
  .sub{color:#5b6b75;font-size:14px;margin-bottom:14px}
  form.inline{display:inline}
  input{font-size:16px;padding:10px 12px;border:1px solid #b9c6cd;border-radius:8px;width:100%;max-width:320px}
  button{font-size:15px;padding:10px 16px;border:0;border-radius:8px;background:#01517E;color:#fff;cursor:pointer;margin:8px 8px 0 0}
  button.alt{background:#36941E}
  .wrap{overflow-x:auto;background:#fff;border-radius:10px;border:1px solid #d7e0e5}
  table{border-collapse:collapse;width:100%;font-size:14px}
  th,td{text-align:left;padding:10px;border-bottom:1px solid #e6ecef;vertical-align:top}
  th{background:#eaf1f5;white-space:nowrap}
  .tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:bold}
  .call{background:#fbe4d0;color:#a34700}.stop{background:#eee;color:#555}.err{background:#fde2e1;color:#b3261e}
  a{color:#01517E}
  .err-box{color:#b3261e;margin-top:8px}
</style></head><body><main>${body}</main></body></html>`;
}

function loginForm(error) {
  return page(`<h1>WhatsApp Leads</h1><div class="sub">Ronch Excel catalogue bot</div>
<form method="post"><input type="password" name="key" placeholder="Password" autofocus required><br>
<button type="submit">Show leads</button></form>${error ? '<div class="err-box">Wrong password.</div>' : ''}`);
}

async function loadLeads() {
  const store = getStore('leads');
  const { blobs } = await store.list();
  const leads = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })));
  return leads.filter(Boolean).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

function csv(leads) {
  const cell = v => {
    let s = String(v == null ? '' : v).replace(/\r?\n/g, ' ');
    if (/^[=@]/.test(s) || (/^[+\-]/.test(s) && !/^\+?[\d\s]+$/.test(s))) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const head = ['Name (WhatsApp)', 'Mobile', 'Catalogues sent', 'Call back requested', 'Messages', 'First contact', 'Last contact', 'Opted out', 'Last error'];
  const rows = leads.map(l => [l.name, l.mobile, (l.catalogues || []).join('; '), l.callBack ? ist(l.callBack) : '',
    (l.messages || []).map(m => m.text).join(' | '), ist(l.firstAt), ist(l.lastAt), l.optOut ? ist(l.optOut) : '',
    l.lastError ? l.lastError.error : ''].map(cell).join(','));
  return '﻿' + [head.map(cell).join(',')].concat(rows).join('\r\n');
}

function table(leads, key) {
  const calls = leads.filter(l => l.callBack && !l.optOut).length;
  const rows = leads.map(l => {
    const digits = String(l.mobile || '').replace(/\D/g, '');
    const tags = (l.callBack ? '<span class="tag call">Call back</span> ' : '') + (l.optOut ? '<span class="tag stop">Opted out</span> ' : '') + (l.lastError ? `<span class="tag err" title="${esc(l.lastError.error)}">Send failed</span>` : '');
    return `<tr><td><b>${esc(l.name || '-')}</b><br>${tags}</td>
<td><a href="tel:+${digits}">${esc(l.mobile)}</a><br><a href="https://wa.me/${digits}" target="_blank" rel="noopener">WhatsApp</a></td>
<td>${esc((l.catalogues || []).join(', '))}</td>
<td>${(l.messages || []).map(m => esc(m.text)).join('<br>')}</td>
<td>${esc(ist(l.lastAt))}<br><span style="color:#5b6b75">first ${esc(ist(l.firstAt))}</span></td></tr>`;
  }).join('');
  return page(`<h1>WhatsApp Leads</h1>
<div class="sub">${leads.length} visitors · ${calls} waiting for a call back · times in IST</div>
<form method="post" class="inline"><input type="hidden" name="key" value="${esc(key)}"><button type="submit">Refresh</button></form>
<form method="post" class="inline"><input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="format" value="csv"><button type="submit" class="alt">Download CSV (Excel)</button></form>
<div class="wrap" style="margin-top:14px"><table><thead><tr><th>Visitor</th><th>Mobile</th><th>Catalogues sent</th><th>Their messages</th><th>Last contact</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5">No leads yet. They appear here as soon as someone messages the bot.</td></tr>'}</tbody></table></div>`);
}

exports.handler = async (event) => {
  const html = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
  if (!(process.env.LEADS_PASSWORD || '').trim()) {
    return { statusCode: 500, headers: html, body: page('<h1>WhatsApp Leads</h1><p>Set LEADS_PASSWORD in Netlify environment variables, then redeploy.</p>') };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 200, headers: html, body: loginForm(false) };

  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const form = new URLSearchParams(raw);
  const key = form.get('key') || '';
  if (!passwordOk(key)) return { statusCode: 401, headers: html, body: loginForm(true) };

  connectLambda(event);
  const leads = await loadLeads();

  if (form.get('format') === 'csv') {
    const date = new Date().toISOString().slice(0, 10);
    return { statusCode: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="whatsapp-leads-${date}.csv"`, 'Cache-Control': 'no-store' }, body: csv(leads) };
  }
  return { statusCode: 200, headers: html, body: table(leads, key) };
};

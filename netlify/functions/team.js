'use strict';
/*
  Stand-team endpoint used by /team.html
  POST JSON { key, action, ... }
    action "login"   -> { ok, template: { status } }
    action "submit"  -> saves the visitor to the shared lead list (same list as /leads) and, if the visitor
                        agreed, sends each chosen catalogue PDF to their WhatsApp from the bot number using an
                        approved template. Falls back to a ready WhatsApp link for the staff phone if the
                        template is not approved yet.
    action "setup"   -> one-time: creates the WhatsApp message template (uploads a sample PDF for Meta's review)
    action "status"  -> template approval status

  Environment variables (in addition to the bot's):
    TEAM_PASSWORD    password for the stand team
    WA_WABA_ID       optional, WhatsApp account ID (default: Ronch Excel Industries account)
    WA_APP_ID        optional, Meta app ID (default: Ronch Catalogue Bot)
*/

const crypto = require('crypto');
const { connectLambda, getStore } = require('@netlify/blobs');
const config = require('./catalogues.json');

const GRAPH = 'https://graph.facebook.com/v21.0';
const TEMPLATE = 'ronch_catalogue_pdf';
const LANG = 'en';
const env = (k, d) => (process.env[k] || d || '').trim();
const WABA = () => env('WA_WABA_ID', '1494248445940563');
const APP = () => env('WA_APP_ID', '1754318569448717');
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });
const siteBase = () => (env('CATALOGUE_BASE_URL') || (env('URL') + '/catalogues')).replace(/\/+$/, '');
const shortBase = () => env('URL').replace(/\/+$/, '');

function teamOk(given) {
  const real = env('TEAM_PASSWORD');
  if (!real || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

function normMobile(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  return d.length >= 11 && d.length <= 15 ? d : '';
}

async function graph(path, opts = {}) {
  const res = await fetch(GRAPH + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + env('WA_TOKEN') }, opts.json ? { 'Content-Type': 'application/json' } : {}, opts.headers || {}),
    body: opts.json ? JSON.stringify(opts.json) : opts.body
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const e = (data && data.error) || {};
    throw new Error(`${res.status} ${e.code || ''} ${e.message || text.slice(0, 200)}`.trim());
  }
  return data;
}

async function templateStatus() {
  try {
    const d = await graph(`/${WABA()}/message_templates?name=${TEMPLATE}&fields=name,status,language,rejected_reason`);
    const t = (d.data || []).find(x => x.name === TEMPLATE);
    return t ? { status: t.status, reason: t.rejected_reason || '' } : { status: 'NOT_CREATED' };
  } catch (err) {
    return { status: 'UNKNOWN', error: String(err.message || err) };
  }
}

async function setupTemplate() {
  const existing = await templateStatus();
  if (existing.status !== 'NOT_CREATED' && existing.status !== 'UNKNOWN') return existing;
  // 1. Upload a sample PDF (Meta needs an example for a document header)
  const d0 = config.divisions[0];
  const pdf = await fetch(`${siteBase()}/${encodeURIComponent(d0.file)}`);
  if (!pdf.ok) throw new Error('Sample catalogue PDF not found on the site: ' + d0.file);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  const sess = await graph(`/${APP()}/uploads?file_name=${encodeURIComponent('catalogue.pdf')}&file_length=${bytes.length}&file_type=application/pdf`, { method: 'POST' });
  const up = await fetch(`${GRAPH}/${sess.id}`, {
    method: 'POST',
    headers: { Authorization: 'OAuth ' + env('WA_TOKEN'), file_offset: '0' },
    body: bytes
  });
  const upData = await up.json();
  if (!up.ok || !upData.h) throw new Error('Sample upload failed: ' + JSON.stringify(upData).slice(0, 200));
  // 2. Create the template
  await graph(`/${WABA()}/message_templates`, {
    method: 'POST',
    json: {
      name: TEMPLATE,
      language: LANG,
      category: 'MARKETING',
      components: [
        { type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [upData.h] } },
        {
          type: 'BODY',
          text: 'Hello {{1}}, thank you for visiting the Ronch Excel Industries stand. As requested, here is our {{2}} catalogue. Reply to this message for prices, samples or a site visit.',
          example: { body_text: [['Rajesh', 'Facade Lighting']] }
        },
        { type: 'FOOTER', text: 'Ronch Excel Industries Pvt Ltd' }
      ]
    }
  });
  return templateStatus();
}

function staffWhatsAppLink(to, name, list) {
  const base = shortBase();
  const lines = list.map(d => `• ${d.title}: ${base}/c/${d.id}`);
  const msg = `Hello ${name || ''}, thank you for visiting Ronch Excel Industries.\n\nOur catalogues:\n${lines.join('\n')}\n\nAll catalogues: ${base}/c\n\nPlease reply for prices or a site visit.`;
  return `https://wa.me/${to}?text=${encodeURIComponent(msg)}`;
}

async function submit(body) {
  const v = body.lead || {};
  const to = normMobile(v.mobile);
  if (!String(v.name || '').trim()) return json(400, { ok: false, error: 'Enter the visitor name.' });
  if (!to) return json(400, { ok: false, error: 'Enter a valid mobile number (10 digits, or with country code).' });

  const ids = Array.isArray(v.interests) ? v.interests : [];
  const list = config.divisions.filter(d => ids.includes(d.id));
  const now = new Date().toISOString();
  const store = getStore('leads');
  const key = 'wa-' + to;
  const lead = (await store.get(key, { type: 'json' })) || { mobile: '+' + to, firstAt: now, catalogues: [], messages: [] };
  const s = x => String(x == null ? '' : x).trim().slice(0, 300);
  Object.assign(lead, {
    fullName: s(v.name), company: s(v.company), designation: s(v.designation), email: s(v.email).toLowerCase(),
    city: s(v.city), visitorType: s(v.visitorType), projectType: s(v.projectType), qty: s(v.qty), timeline: s(v.timeline),
    temp: ['hot', 'warm', 'cold'].includes(v.temp) ? v.temp : 'warm', notes: s(v.notes).slice(0, 1000),
    otherPhones: s(v.otherPhones), address: s(v.address), website: s(v.website),
    interests: list.map(d => d.title), staff: s(body.staff), source: 'Stand team',
    lastAt: now, detailsDone: lead.detailsDone || now
  });
  if (!lead.capturedAt) lead.capturedAt = now;

  const result = { ok: true, saved: true, sent: [], waLink: '' };
  const wantSend = !!body.consent && list.length > 0;

  if (wantSend && lead.optOut) {
    result.note = 'This number replied STOP earlier, so nothing was sent.';
  } else if (wantSend) {
    const t = await templateStatus();
    result.template = t.status;
    if (t.status === 'APPROVED') {
      for (const d of list) {
        try {
          await graph(`/${env('WA_PHONE_NUMBER_ID')}/messages`, {
            method: 'POST',
            json: {
              messaging_product: 'whatsapp', to, type: 'template',
              template: {
                name: TEMPLATE, language: { code: LANG },
                components: [
                  { type: 'header', parameters: [{ type: 'document', document: { link: `${siteBase()}/${encodeURIComponent(d.file)}`, filename: d.filename } }] },
                  { type: 'body', parameters: [{ type: 'text', text: (s(v.name).split(' ')[0] || 'there') }, { type: 'text', text: d.title }] }
                ]
              }
            }
          });
          result.sent.push({ title: d.title, ok: true });
        } catch (err) {
          result.sent.push({ title: d.title, ok: false, error: String(err.message || err).slice(0, 200) });
        }
      }
      const okTitles = result.sent.filter(x => x.ok).map(x => x.title);
      lead.catalogues = Array.from(new Set((lead.catalogues || []).concat(okTitles)));
      const failed = result.sent.filter(x => !x.ok);
      if (failed.length) {
        lead.lastError = { at: now, error: 'Stand send failed: ' + failed[0].error };
        result.waLink = staffWhatsAppLink(to, s(v.name), list);
      } else {
        delete lead.lastError;
      }
    } else {
      result.waLink = staffWhatsAppLink(to, s(v.name), list);
      result.note = t.status === 'NOT_CREATED' ? 'Automatic sending is not set up yet.' : `Automatic sending is waiting for Meta approval (${t.status}).`;
    }
  }
  await store.setJSON(key, lead);
  return json(200, result);
}

async function listLeads() {
  const store = getStore('leads');
  const { blobs } = await store.list();
  const all = await Promise.all(blobs.map(x => store.get(x.key, { type: 'json' })));
  const pick = l => ({
    name: l.fullName || l.name || '', waName: l.name || '', mobile: l.mobile || '', company: l.company || '', designation: l.designation || '',
    city: l.city || '', email: l.email || '', source: l.source || 'WhatsApp QR', staff: l.staff || '', temp: l.temp || '',
    visitorType: l.visitorType || '', projectType: l.projectType || '', qty: l.qty || '', timeline: l.timeline || '',
    interests: l.interests || [], catalogues: l.catalogues || [], notes: l.notes || '',
    messages: (l.messages || []).map(m => m.text).slice(-5), callBack: !!l.callBack, optOut: !!l.optOut,
    error: l.lastError ? l.lastError.error : '', firstAt: l.firstAt || '', lastAt: l.lastAt || ''
  });
  const leads = all.filter(Boolean).map(pick).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  return json(200, { ok: true, leads });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Bad request' }); }
  if (!env('TEAM_PASSWORD')) return json(500, { ok: false, error: 'TEAM_PASSWORD is not set in Netlify.' });
  if (!teamOk(body.key)) return json(401, { ok: false, error: 'Wrong team password' });
  connectLambda(event);
  try {
    if (body.action === 'login') return json(200, { ok: true, template: await templateStatus() });
    if (body.action === 'status') return json(200, { ok: true, template: await templateStatus() });
    if (body.action === 'setup') return json(200, { ok: true, template: await setupTemplate() });
    if (body.action === 'submit') return await submit(body);
    if (body.action === 'list') return await listLeads();
    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('team error', err);
    return json(500, { ok: false, error: String(err.message || err).slice(0, 300) });
  }
};

exports._test = { normMobile, staffWhatsAppLink };

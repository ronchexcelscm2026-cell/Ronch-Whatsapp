'use strict';
/*
  WhatsApp catalogue bot (Meta WhatsApp Business Cloud API).

  Flow at the stand:
    1. Visitor scans the stand QR -> WhatsApp opens with "Hi, please send me your catalogue" to our number.
    2. Any message from the visitor -> bot replies with a menu of the five divisions (+ All, + Talk to sales).
    3. Visitor picks a division -> bot sends that catalogue PDF, then offers "More catalogues" / "Talk to sales".
    4. Every visitor is saved to the site's lead list (Netlify Blobs) - see /leads for the table and CSV.

  Because the visitor messages first, all replies fall inside WhatsApp's 24-hour customer-service
  window, so no message templates are needed.

  Webhook URL to give Meta:  https://<your-site>/.netlify/functions/whatsapp

  Environment variables (Netlify > Site configuration > Environment variables):
    WA_TOKEN            permanent System User access token (whatsapp_business_messaging permission)
    WA_PHONE_NUMBER_ID  Phone number ID from WhatsApp > API Setup
    WA_VERIFY_TOKEN     any secret text; type the same text in Meta's webhook setup
    WA_APP_SECRET       App secret (App settings > Basic) - used to check messages really come from Meta
    CATALOGUE_BASE_URL  optional; defaults to <your-site>/catalogues
*/

const crypto = require('crypto');
const { connectLambda, getStore } = require('@netlify/blobs');
const config = require('./catalogues.json');

const GRAPH = 'https://graph.facebook.com/v21.0';
const env = (k, d) => (process.env[k] || d || '').trim();

function siteBase() {
  const b = env('CATALOGUE_BASE_URL') || ((env('URL') || '') + '/catalogues');
  return b.replace(/\/+$/, '');
}

/* ---------- WhatsApp sending ---------- */

async function waSend(payload) {
  const res = await fetch(`${GRAPH}/${env('WA_PHONE_NUMBER_ID')}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('WA_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${text.slice(0, 300)}`);
  console.log('Sent', payload.type, 'to', payload.to);
  return text;
}

const sendText = (to, body) => waSend({ to, type: 'text', text: { body } });

function sendMenu(to, body) {
  const rows = config.divisions.map(d => ({ id: 'cat:' + d.id, title: d.title.slice(0, 24), description: d.description.slice(0, 72) }));
  rows.push({ id: 'cat:all', title: 'All catalogues', description: 'Receive every division catalogue' });
  return waSend({
    to, type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: config.company.slice(0, 60) },
      body: { text: body.slice(0, 1024) },
      footer: { text: config.website.slice(0, 60) },
      action: {
        button: 'View catalogues',
        sections: [
          { title: 'Catalogues', rows },
          { title: 'Contact', rows: [{ id: 'sales', title: 'Talk to sales', description: 'Get a call back from our team' }] }
        ]
      }
    }
  });
}

function sendFollowUp(to) {
  return waSend({
    to, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: config.afterSend },
      action: { buttons: [
        { type: 'reply', reply: { id: 'menu', title: 'More catalogues' } },
        { type: 'reply', reply: { id: 'sales', title: 'Talk to sales' } }
      ] }
    }
  });
}

function sendCatalogue(to, d) {
  return waSend({
    to, type: 'document',
    document: { link: `${siteBase()}/${d.file}`, filename: d.filename, caption: `${d.title} catalogue - ${config.company}` }
  });
}

/* ---------- Lead list (Netlify Blobs) ---------- */

// One record per visitor number; every event updates it.
async function recordLead(from, name, patch) {
  try {
    const store = getStore('leads');
    const key = 'wa-' + from;
    const now = new Date().toISOString();
    const lead = (await store.get(key, { type: 'json' })) || { mobile: '+' + from, firstAt: now, catalogues: [], messages: [] };
    if (name) lead.name = name;
    lead.lastAt = now;
    if (patch.catalogues) lead.catalogues = Array.from(new Set(lead.catalogues.concat(patch.catalogues)));
    if (patch.message) lead.messages = lead.messages.concat([{ at: now, text: patch.message.slice(0, 500) }]).slice(-10);
    if (patch.sales) lead.callBack = now;
    if (patch.optOut) lead.optOut = now;
    if (patch.failed) lead.lastError = { at: now, error: patch.failed.slice(0, 300) };
    await store.setJSON(key, lead);
  } catch (err) {
    console.error('Lead save failed', from, err && err.message);
  }
}


/* ---------- Handling one incoming message ---------- */

async function handleMessage(msg, contact) {
  const from = msg.from;                       // visitor's number, e.g. 919876543210
  const name = (contact && contact.profile && contact.profile.name) || '';

  let choice = null;
  if (msg.type === 'interactive') {
    const i = msg.interactive || {};
    choice = (i.list_reply && i.list_reply.id) || (i.button_reply && i.button_reply.id) || null;
  } else if (msg.type === 'text') {
    const t = ((msg.text && msg.text.body) || '').trim().toLowerCase();
    if (t === 'stop' || t === 'unsubscribe') {
      await sendText(from, 'Done. We will not send you further messages. Reply HI any time to get our catalogues again.');
      await recordLead(from, name, { optOut: true });
      return;
    }
    if (/^[1-5]$/.test(t)) choice = 'cat:' + config.divisions[Number(t) - 1].id;
    else if (t === '6' || t === 'all') choice = 'cat:all';
    else if (/\b(sales|call|price|quote|quotation)\b/.test(t)) choice = 'sales';
    else {
      // First contact or free text: show the menu, and pass any typed text to sales.
      await sendMenu(from, config.welcome);
      await recordLead(from, name, { message: msg.text.body });
      return;
    }
  } else {
    await sendMenu(from, config.welcome);
    await recordLead(from, name, {});
    return;
  }

  if (choice === 'menu') return sendMenu(from, 'Pick a division to receive its catalogue.');

  if (choice === 'sales') {
    await sendText(from, config.salesReply);
    await recordLead(from, name, { sales: true });
    return;
  }

  if (choice && choice.startsWith('cat:')) {
    const id = choice.slice(4);
    const list = id === 'all' ? config.divisions : config.divisions.filter(d => d.id === id);
    if (!list.length) return sendMenu(from, config.welcome);
    for (const d of list) await sendCatalogue(from, d);   // in order, so PDFs arrive in menu order
    await sendFollowUp(from);
    await recordLead(from, name, { catalogues: list.map(d => d.title) });
    return;
  }

  return sendMenu(from, config.welcome);
}

/* ---------- Netlify handler ---------- */

function validSignature(raw, header) {
  const secret = env('WA_APP_SECRET');
  if (!secret) return true; // allowed during first setup only; set WA_APP_SECRET before the show
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const got = header.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

const seen = new Set();

exports.handler = async (event) => {
  // Meta's one-time webhook verification
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    console.log('Webhook verification request from Meta');
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && q['hub.verify_token'] === env('WA_VERIFY_TOKEN')) {
      return { statusCode: 200, body: q['hub.challenge'] || '' };
    }
    return { statusCode: 403, body: 'Forbidden' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  console.log('Webhook POST received, bytes:', raw.length);
  if (!validSignature(raw, headers['x-hub-signature-256'])) {
    console.error('REJECTED: signature does not match. WA_APP_SECRET in Netlify is not this app\'s App secret.');
    return { statusCode: 401, body: 'Bad signature' };
  }
  if (!env('WA_TOKEN') || !env('WA_PHONE_NUMBER_ID')) console.error('WA_TOKEN or WA_PHONE_NUMBER_ID is missing in Netlify environment variables.');

  connectLambda(event);

  let data;
  try { data = JSON.parse(raw); } catch { return { statusCode: 400, body: 'Bad JSON' }; }

  const jobs = [];
  for (const entry of data.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      // Delivery failures of our own messages (e.g. a PDF link that could not be fetched)
      for (const s of v.statuses || []) {
        if (s.status === 'failed') {
          const err = (s.errors && s.errors[0]) || {};
          jobs.push(recordLead(s.recipient_id, '', { failed: `Delivery failed: ${err.code || ''} ${err.title || ''} ${(err.error_data && err.error_data.details) || ''}`.trim() }));
        }
      }
      console.log('Event:', change.field, '| messages:', (v.messages || []).length, '| statuses:', (v.statuses || []).map(s => s.status).join(',') || '-');
      const contacts = v.contacts || [];
      for (const msg of v.messages || []) {
        if (seen.has(msg.id)) continue;        // Meta sometimes delivers the same message twice
        seen.add(msg.id); if (seen.size > 2000) seen.delete(seen.values().next().value);
        const contact = contacts.find(c => c.wa_id === msg.from) || contacts[0];
        jobs.push(handleMessage(msg, contact).catch(err => {
          console.error(err);
          return recordLead(msg.from, '', { failed: 'Bot error: ' + String(err.message || err) });
        }));
      }
    }
  }
  await Promise.allSettled(jobs);
  // Always 200 so Meta does not retry the same message (which would resend PDFs).
  return { statusCode: 200, body: 'ok' };
};

exports._test = { handleMessage, validSignature };

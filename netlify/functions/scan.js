'use strict';
/*
  Visiting-card reader for the team page.
  POST JSON { key, images: ["data:image/jpeg;base64,...", (optional back side)] }
  Returns   { ok:true, fields:{ name, company, designation, mobile, otherPhones, email, city, website, address } }

  Environment variables:
    TEAM_PASSWORD      password the stand team types on /team
    ANTHROPIC_API_KEY  key from console.anthropic.com
    SCAN_MODEL         optional, default claude-haiku-5-5
*/

const crypto = require('crypto');

const env = k => (process.env[k] || '').trim();
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

function teamOk(given) {
  const real = env('TEAM_PASSWORD');
  if (!real || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

const PROMPT = (two) =>
  (two ? 'These two images are the front and back of ONE business / visiting card' : 'This image is a business / visiting card') +
  ' handed to us at an exhibition stand in India. Read it carefully and reply with ONLY one JSON object, no other text:\n' +
  '{"name":"","company":"","designation":"","mobile":"","otherPhones":"","email":"","city":"","website":"","address":""}\n' +
  'Rules: use "" for anything not on the card; never guess or invent. name = the person, not the company. ' +
  'mobile = the person\'s mobile (prefer a 10-digit Indian mobile starting 6-9; keep +91 if printed), digits with optional leading +, no spaces. ' +
  'otherPhones = any other numbers separated by ", ". email = the person\'s own email if several. city = city or town only. ' +
  'address = full postal address on one line. website without http. ' +
  'Write names in normal capitalisation (Rajesh Kumar, not RAJESH KUMAR); keep company names as printed. ' +
  'If the card is in Hindi or another script, give the English / transliterated form.';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Bad request' }); }
  if (!teamOk(body.key)) return json(401, { ok: false, error: 'Wrong team password' });
  if (!env('ANTHROPIC_API_KEY')) return json(500, { ok: false, error: 'Card reading is not set up (ANTHROPIC_API_KEY missing in Netlify).' });

  const imgs = (Array.isArray(body.images) ? body.images : []).slice(0, 2)
    .map(s => /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(String(s || '')))
    .filter(Boolean);
  if (!imgs.length) return json(400, { ok: false, error: 'No card photo received' });
  if (imgs.some(m => m[3].length > 4_500_000)) return json(413, { ok: false, error: 'Photo too large' });

  const content = imgs.map(m => ({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[3] } }));
  content.push({ type: 'text', text: PROMPT(imgs.length > 1) });

  let res, data;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: env('SCAN_MODEL') || 'claude-haiku-5-5', max_tokens: 600, messages: [{ role: 'user', content }] })
    });
    data = await res.json();
  } catch (err) {
    console.error('Anthropic call failed', err && err.message);
    return json(502, { ok: false, error: 'Card reader could not be reached. Try again.' });
  }
  if (!res.ok) {
    console.error('Anthropic error', res.status, JSON.stringify(data).slice(0, 300));
    return json(502, { ok: false, error: res.status === 401 ? 'Card reader key is wrong (ANTHROPIC_API_KEY).' : 'Card reader error. Try again.' });
  }
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  let fields = {};
  try { fields = m ? JSON.parse(m[0]) : {}; } catch { fields = {}; }
  const keys = ['name', 'company', 'designation', 'mobile', 'otherPhones', 'email', 'city', 'website', 'address'];
  const clean = {};
  keys.forEach(k => { const v = fields[k]; clean[k] = v == null ? '' : String(v).trim().slice(0, 200); });
  if (clean.email) clean.email = clean.email.toLowerCase().replace(/\s+/g, '');
  return json(200, { ok: true, fields: clean });
};

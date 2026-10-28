// RT4 - Demo DNI + NICE CXone
// Middleware en memoria: asignación de DID, recepción de llamada desde Studio,
// screen pop para el agente y envío de conversiones offline (Google Ads / Meta CAPI).
// Todo se pierde al reiniciar (suficiente para demo).

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ---------------- Configuración (variables de entorno) ----------------
const CFG = {
  port: process.env.PORT || 3000,
  brand: process.env.BRAND_NAME || 'Clínica Demo',
  // Pool de DIDs separado por comas. Formato E.164: +5255XXXXXXXX
  pool: (process.env.DID_POOL || '+525500000000').split(',').map(s => s.trim()).filter(Boolean),
  ttlMin: Number(process.env.DNI_TTL_MIN || 30),
  webhookForwardUrl: process.env.WEBHOOK_FORWARD_URL || '', // opcional: reenviar call.received a CRM / webhook.site
  google: {
    mode: process.env.GOOGLE_MODE || 'mock', // mock | validate | live
    // datamanager = Data Manager API (ruta vigente para integraciones nuevas)
    // ads = Google Ads API uploadClickConversions (solo integraciones existentes / allowlist)
    api: (process.env.GOOGLE_API || 'datamanager').toLowerCase(),
    eventSource: process.env.GOOGLE_EVENT_SOURCE || 'PHONE', // WEB | APP | IN_STORE | PHONE | MESSAGE | OTHER
    apiVersion: process.env.GOOGLE_ADS_API_VERSION || '', // verificar versión vigente
    customerId: (process.env.GOOGLE_ADS_CUSTOMER_ID || '1234567890').replace(/-/g, ''),
    loginCustomerId: (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, ''),
    conversionActionId: process.env.GOOGLE_ADS_CONVERSION_ACTION_ID || '987654321',
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || ''
  },
  meta: {
    mode: process.env.META_MODE || 'mock', // mock | live
    apiVersion: process.env.META_API_VERSION || '', // verificar versión vigente, ej. v21.0
    pixelId: process.env.META_PIXEL_ID || '000000000000000',
    accessToken: process.env.META_ACCESS_TOKEN || '',
    testEventCode: process.env.META_TEST_EVENT_CODE || '',
    eventName: process.env.META_EVENT_NAME || 'Schedule'
  },
  wa: {
    // Número de WhatsApp del canal en CXone (solo dígitos con lada país, ej. 5215512345678)
    number: String(process.env.WA_NUMBER || '').replace(/\D/g, ''),
    refPrefix: (process.env.WA_REF_PREFIX || 'PC').toUpperCase(),
    ttlH: Number(process.env.WA_REF_TTL_H || 72)
  },
  conversionValue: Number(process.env.CONVERSION_VALUE || 500),
  currency: process.env.CONVERSION_CURRENCY || 'MXN',
  tzOffset: process.env.TZ_OFFSET || '-06:00'
};

// ---------------- Estado en memoria ----------------
const state = {
  sessions: {},      // sessionId -> sesión web
  reservations: {},  // did -> { sessionId, assignedAt, expiresAt }
  calls: {},         // contactId -> llamada o conversación de WhatsApp
  waRefs: {},        // código de referencia -> { sessionId, createdAt, expiresAt }
  events: []         // log de eventos (más reciente primero)
};

const now = () => Date.now();
const last10 = n => String(n || '').replace(/\D/g, '').slice(-10);
const fmtDid = did => {
  const d = last10(did);
  return d.length !== 10 ? did : (/^(55|33|81)/.test(d) ? `${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}` : `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`);
};
const sha256 = v => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

function logEvent(type, data) {
  const ev = { id: crypto.randomUUID(), ts: new Date().toISOString(), type, data };
  state.events.unshift(ev);
  if (state.events.length > 200) state.events.pop();
  console.log(`[${ev.ts}] ${type}`, JSON.stringify(data));
  return ev;
}

function purgeExpired() {
  for (const [did, r] of Object.entries(state.reservations)) {
    if (r.expiresAt <= now()) {
      delete state.reservations[did];
      logEvent('dni.released', { did, sessionId: r.sessionId, reason: 'ttl' });
    }
  }
}

// Asigna un DID: 1) si la sesión ya tiene uno vigente, lo renueva;
// 2) si hay DID libre, lo asigna; 3) si el pool está lleno, desplaza la reserva más antigua.
function assignDid(sessionId) {
  purgeExpired();
  const ttl = CFG.ttlMin * 60 * 1000;
  for (const [did, r] of Object.entries(state.reservations)) {
    if (r.sessionId === sessionId) {
      r.expiresAt = now() + ttl;
      return { did, renewed: true };
    }
  }
  let did = CFG.pool.find(d => !state.reservations[d]);
  let displaced = null;
  if (!did) {
    const oldest = Object.entries(state.reservations).sort((a, b) => a[1].assignedAt - b[1].assignedAt)[0];
    did = oldest[0];
    displaced = oldest[1].sessionId;
    if (state.sessions[displaced]) state.sessions[displaced].displaced = true;
    logEvent('dni.displaced', { did, from: displaced, to: sessionId, note: 'Pool lleno: la reserva más antigua pierde el número' });
  }
  state.reservations[did] = { sessionId, assignedAt: now(), expiresAt: now() + ttl };
  return { did, renewed: false, displaced };
}

// ---------------- API: web / DNI ----------------
app.post('/api/dni/assign', (req, res) => {
  const b = req.body || {};
  const sessionId = b.sessionId || crypto.randomUUID();
  const s = state.sessions[sessionId] || {
    sessionId, createdAt: new Date().toISOString(), pages: [], displaced: false
  };
  // Solo se sobrescriben parámetros de pauta si vienen en esta visita (first-touch dentro de la sesión)
  const pick = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'referrer', 'landing'];
  for (const k of pick) if (b[k] && !s[k]) s[k] = String(b[k]).slice(0, 300);
  if (b.page) s.pages.push({ page: String(b.page).slice(0, 200), at: new Date().toISOString() });
  s.displaced = false;
  state.sessions[sessionId] = s;

  const { did, renewed, displaced } = assignDid(sessionId);
  s.did = did;
  if (!renewed) logEvent('dni.assigned', { did, sessionId, utm_campaign: s.utm_campaign, gclid: s.gclid });
  res.json({
    sessionId, did, display: fmtDid(did), tel: did,
    expiresAt: new Date(state.reservations[did].expiresAt).toISOString(),
    displacedSession: displaced || null
  });
});

app.post('/api/dni/pageview', (req, res) => {
  const { sessionId, page } = req.body || {};
  const s = state.sessions[sessionId];
  if (!s) return res.status(404).json({ error: 'session not found' });
  s.pages.push({ page: String(page || '').slice(0, 200), at: new Date().toISOString() });
  res.json({ ok: true });
});

function attributionOf(s) {
  return s ? {
    utm_source: s.utm_source || '', utm_medium: s.utm_medium || '',
    utm_campaign: s.utm_campaign || '', utm_term: s.utm_term || '',
    utm_content: s.utm_content || '', gclid: s.gclid || '', fbclid: s.fbclid || '',
    landing: s.landing || '', firstSeen: s.createdAt || '', pages: s.pages.slice(-10)
  } : null;
}

// ---------------- API: CXone Studio (webhook de llamada entrante) ----------------
// Llamado desde la acción REST API de Studio al entrar la llamada.
// Respuesta plana y pequeña (límite de 32 KB en CXone).
async function callReceived(req, res) {
  const q = { ...req.query, ...(req.body || {}) };
  const contactId = String(q.contactId || q.ContactID || `sim-${Date.now()}`);
  const dnis = q.dnis || q.DNIS || '';
  const ani = q.ani || q.ANI || '';
  purgeExpired();

  const did = CFG.pool.find(d => last10(d) === last10(dnis));
  const r = did && state.reservations[did];
  const s = r && state.sessions[r.sessionId];

  const call = {
    contactId, dnis, ani,
    receivedAt: new Date().toISOString(),
    attributed: Boolean(s),
    sessionId: s ? s.sessionId : null,
    channel: 'voz',
    attribution: attributionOf(s),
    conversion: null
  };
  state.calls[contactId] = call;
  logEvent('call.received', {
    contactId, dnis, ani, attributed: call.attributed,
    utm_campaign: call.attribution?.utm_campaign || '', gclid: call.attribution?.gclid || ''
  });

  // Reenvío opcional del webhook (CRM, webhook.site, etc.) sin bloquear a CXone
  if (CFG.webhookForwardUrl) {
    fetch(CFG.webhookForwardUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'call.received', ...call })
    }).then(r => logEvent('webhook.forwarded', { status: r.status }))
      .catch(e => logEvent('webhook.forward_error', { error: e.message }));
  }

  res.json({
    attributed: call.attributed ? 1 : 0,
    utm_source: call.attribution?.utm_source || '',
    utm_campaign: call.attribution?.utm_campaign || '',
    gclid_present: call.attribution?.gclid ? 1 : 0,
    pop_url: `${req.protocol}://${req.get('host')}/agent.html?contactId=${encodeURIComponent(contactId)}`
  });
}
app.get('/api/cxone/call-received', callReceived);
app.post('/api/cxone/call-received', callReceived);


// ---------------- WhatsApp: código de referencia en el mensaje ----------------
// La landing genera un código por visita (ej. PC-7K2Q) y lo precarga en el texto de WhatsApp.
// Cuando el mensaje entra a CXone, el script digital de Studio manda el texto aquí y se liga la visita.
const REF_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRef() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += REF_CHARS[crypto.randomInt(REF_CHARS.length)];
    const ref = `${CFG.wa.refPrefix}-${c}`;
    if (!state.waRefs[ref]) return ref;
  }
}
function findRef(text) {
  const m = String(text || '').toUpperCase().match(new RegExp(`\\b${CFG.wa.refPrefix}-[${REF_CHARS}]{4}\\b`));
  return m ? m[0] : null;
}

app.post('/api/wa/link', (req, res) => {
  const { sessionId } = req.body || {};
  const s = state.sessions[sessionId];
  if (!s) return res.status(404).json({ error: 'session not found' });
  let ref = s.waRef;
  const r = ref && state.waRefs[ref];
  if (!r || r.expiresAt <= now()) {
    ref = newRef();
    state.waRefs[ref] = { sessionId, createdAt: now(), expiresAt: now() + CFG.wa.ttlH * 3600 * 1000 };
    s.waRef = ref;
    logEvent('wa.ref_created', { ref, sessionId, utm_campaign: s.utm_campaign || '', gclid: s.gclid || '', fbclid: s.fbclid || '' });
  }
  const text = `Hola, quiero agendar una cita. Ref: ${ref}`;
  res.json({ ref, text, number: CFG.wa.number || null, url: CFG.wa.number ? `https://wa.me/${CFG.wa.number}?text=${encodeURIComponent(text)}` : null });
});

function linkWhatsApp({ contactId, text, from, ref }) {
  const code = findRef(ref) || findRef(text);
  const r = code && state.waRefs[code];
  const s = r && r.expiresAt > now() ? state.sessions[r.sessionId] : null;
  const prev = state.calls[contactId];
  const conv = {
    contactId, channel: 'whatsapp',
    ani: from || prev?.ani || '', dnis: 'WhatsApp',
    message: String(text || prev?.message || '').slice(0, 500),
    ref: (s ? code : null) || prev?.ref || null,
    receivedAt: prev?.receivedAt || new Date().toISOString(),
    attributed: Boolean(s) || Boolean(prev?.attributed),
    sessionId: s ? s.sessionId : prev?.sessionId || null,
    attribution: s ? attributionOf(s) : prev?.attribution || null,
    conversion: prev?.conversion || null
  };
  state.calls[contactId] = conv;
  logEvent('wa.received', { contactId, ref: conv.ref, attributed: conv.attributed, utm_campaign: conv.attribution?.utm_campaign || '', gclid: conv.attribution?.gclid || '' });
  return conv;
}

// Webhook desde el script digital de Studio (acción REST API). Respuesta plana y pequeña.
async function waReceived(req, res) {
  const q = { ...req.query, ...(req.body || {}) };
  const contactId = String(q.contactId || q.ContactID || `wa-${Date.now()}`);
  const conv = linkWhatsApp({ contactId, text: q.text || q.message || q.msg || '', from: q.from || q.ani || q.phone || '', ref: q.ref || '' });
  res.json({
    attributed: conv.attributed ? 1 : 0, ref: conv.ref || '',
    utm_source: conv.attribution?.utm_source || '', utm_campaign: conv.attribution?.utm_campaign || '',
    pop_url: `${req.protocol}://${req.get('host')}/agent.html?contactId=${encodeURIComponent(contactId)}`
  });
}
app.get('/api/cxone/wa-received', waReceived);
app.post('/api/cxone/wa-received', waReceived);

// Plan B: el asesor captura el código en el pop
app.post('/api/wa/attach', (req, res) => {
  const { contactId, ref, from } = req.body || {};
  if (!contactId || !ref) return res.status(400).json({ error: 'contactId y ref son requeridos' });
  const conv = linkWhatsApp({ contactId: String(contactId), ref, from });
  if (!conv.attributed) return res.status(404).json({ error: 'Código no encontrado o vencido', call: conv });
  res.json(conv);
});

app.get('/api/calls/latest', (req, res) => {
  const calls = Object.values(state.calls).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  res.json(calls[0] || null);
});
app.get('/api/calls/:contactId', (req, res) => {
  const c = state.calls[req.params.contactId];
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
});

// ---------------- Conversiones offline ----------------
function googleDateTime(d = new Date()) {
  // Formato requerido: yyyy-mm-dd hh:mm:ss+|-hh:mm (hora local según TZ_OFFSET)
  const sign = CFG.tzOffset.startsWith('-') ? -1 : 1;
  const [hh, mm] = CFG.tzOffset.replace(/[+-]/, '').split(':').map(Number);
  const local = new Date(d.getTime() + sign * (hh * 60 + mm) * 60000);
  const p = n => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())} ` +
    `${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}${CFG.tzOffset}`;
}

async function googleAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CFG.google.clientId, client_secret: CFG.google.clientSecret,
      refresh_token: CFG.google.refreshToken, grant_type: 'refresh_token'
    })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('OAuth: ' + JSON.stringify(j));
  return j.access_token;
}

async function sendGoogle(call) {
  return CFG.google.api === 'ads' ? sendGoogleAds(call) : sendGoogleDataManager(call);
}

// Data Manager API: POST https://datamanager.googleapis.com/v1/events:ingest
// Scope OAuth: https://www.googleapis.com/auth/datamanager
async function sendGoogleDataManager(call) {
  const g = CFG.google;
  const gclid = call.attribution?.gclid;
  const url = 'https://datamanager.googleapis.com/v1/events:ingest';
  const destination = {
    operatingAccount: { accountType: 'GOOGLE_ADS', accountId: g.customerId },
    productDestinationId: String(g.conversionActionId)
  };
  if (g.loginCustomerId) destination.loginAccount = { accountType: 'GOOGLE_ADS', accountId: g.loginCustomerId };
  const body = {
    destinations: [destination],
    encoding: 'HEX',
    consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED' },
    events: [{
      adIdentifiers: { gclid: gclid || '(sin gclid)' },
      conversionValue: CFG.conversionValue,
      currency: CFG.currency,
      eventTimestamp: googleDateTime().replace(' ', 'T'),
      transactionId: `${call.channel === 'whatsapp' ? 'wa' : 'call'}-${call.contactId}`,
      eventSource: call.channel === 'whatsapp' ? 'MESSAGE' : g.eventSource
    }],
    validateOnly: g.mode !== 'live'
  };
  if (!gclid) return { api: 'datamanager', mode: g.mode, skipped: true, reason: 'La sesión no trae gclid', url, request: body };
  if (g.mode === 'mock') {
    return { api: 'datamanager', mode: 'mock', url, request: body, response: { requestId: 'mock-' + Date.now() }, note: 'Payload real; envío simulado' };
  }
  const token = await googleAccessToken();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  const response = await r.json().catch(() => ({}));
  return { api: 'datamanager', mode: g.mode, url, status: r.status, request: body, response };
}

// Google Ads API uploadClickConversions (limitado a integraciones existentes)
async function sendGoogleAds(call) {
  const g = CFG.google;
  const gclid = call.attribution?.gclid;
  const url = `https://googleads.googleapis.com/${g.apiVersion || '{VERSION}'}/customers/${g.customerId}:uploadClickConversions`;
  const body = {
    conversions: [{
      gclid: gclid || '(sin gclid)',
      conversionAction: `customers/${g.customerId}/conversionActions/${g.conversionActionId}`,
      conversionDateTime: googleDateTime(),
      conversionValue: CFG.conversionValue,
      currencyCode: CFG.currency
    }],
    partialFailure: true,
    validateOnly: g.mode !== 'live'
  };
  if (!gclid) return { mode: g.mode, skipped: true, reason: 'La sesión no trae gclid', url, request: body };
  if (g.mode === 'mock') {
    return {
      mode: 'mock', url, request: body,
      response: { results: [{ gclid, conversionAction: body.conversions[0].conversionAction, conversionDateTime: body.conversions[0].conversionDateTime }], partialFailureError: null },
      note: 'Payload real; envío simulado (pendiente developer token)'
    };
  }
  const token = await googleAccessToken();
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'developer-token': g.developerToken || 'cloud-managed'
  };
  if (g.loginCustomerId) headers['login-customer-id'] = g.loginCustomerId;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const response = await r.json().catch(() => ({}));
  return { mode: g.mode, url, status: r.status, request: body, response };
}

async function sendMeta(call, phone) {
  const m = CFG.meta;
  const url = `https://graph.facebook.com/${m.apiVersion || '{VERSION}'}/${m.pixelId}/events`;
  const userData = {};
  const ph = String(phone || call.ani || '').replace(/\D/g, '');
  // México: 10 dígitos → 52 + número; WhatsApp entrega 521 + 10 dígitos → se normaliza a 52 + 10
  const phNorm = ph.length === 10 ? '52' + ph : (ph.length === 13 && ph.startsWith('521') ? '52' + ph.slice(3) : ph);
  if (ph) userData.ph = [sha256(phNorm)];
  // Click ID de Meta: fbc = fb.1.<ms en que se capturó el fbclid>.<fbclid>
  const fbclid = call.attribution?.fbclid;
  if (fbclid) {
    const seen = Date.parse(call.attribution.firstSeen || '') || Date.now();
    userData.fbc = `fb.1.${seen}.${fbclid}`;
  }
  // Solo datos no clínicos. Nunca especialidad, síntomas ni diagnóstico.
  const body = {
    data: [{
      event_name: m.eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: `${call.channel === 'whatsapp' ? 'wa' : 'call'}-${call.contactId}`,
      action_source: call.channel === 'whatsapp' ? 'chat' : 'phone_call',
      user_data: userData,
      custom_data: { value: CFG.conversionValue, currency: CFG.currency }
    }]
  };
  if (m.testEventCode) body.test_event_code = m.testEventCode;
  if (m.mode === 'mock') {
    return { mode: 'mock', url, request: body, response: { events_received: 1, fbtrace_id: 'MOCK' + Date.now() }, note: 'Payload real; envío simulado' };
  }
  const r = await fetch(`${url}?access_token=${encodeURIComponent(m.accessToken)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const response = await r.json().catch(() => ({}));
  return { mode: m.mode, url, status: r.status, request: body, response };
}

app.post('/api/conversion', async (req, res) => {
  const { contactId, outcome = 'cita_agendada', phone } = req.body || {};
  const call = state.calls[contactId];
  if (!call) return res.status(404).json({ error: 'contactId no encontrado' });
  if (outcome !== 'cita_agendada') {
    call.conversion = { outcome, at: new Date().toISOString(), sent: false };
    logEvent('disposition', { contactId, outcome });
    return res.json(call.conversion);
  }
  const [google, meta] = await Promise.all([
    sendGoogle(call).catch(e => ({ error: e.message })),
    sendMeta(call, phone).catch(e => ({ error: e.message }))
  ]);
  call.conversion = { outcome, at: new Date().toISOString(), google, meta };
  logEvent('conversion.google', { contactId, mode: google.mode, skipped: !!google.skipped, status: google.status || 'mock', error: google.error });
  logEvent('conversion.meta', { contactId, mode: meta.mode, status: meta.status || 'mock', error: meta.error });
  res.json(call.conversion);
});

// ---------------- Panel ----------------
app.get('/api/state', (req, res) => {
  purgeExpired();
  res.json({
    brand: CFG.brand,
    ttlMin: CFG.ttlMin,
    modes: { google: CFG.google.mode, googleApi: CFG.google.api, meta: CFG.meta.mode, whatsapp: CFG.wa.number ? 'on' : 'off' },
    pool: CFG.pool.map(did => {
      const r = state.reservations[did];
      return {
        did, display: fmtDid(did),
        status: r ? 'reservado' : 'libre',
        sessionId: r?.sessionId || null,
        utm_campaign: r ? state.sessions[r.sessionId]?.utm_campaign || '' : '',
        expiresInSec: r ? Math.max(0, Math.round((r.expiresAt - now()) / 1000)) : null
      };
    }),
    sessions: Object.values(state.sessions).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20),
    calls: Object.values(state.calls).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 20),
    events: state.events.slice(0, 60)
  });
});

app.get('/api/config', (req, res) => res.json({ brand: CFG.brand }));

app.post('/api/reset', (req, res) => {
  state.sessions = {}; state.reservations = {}; state.calls = {}; state.waRefs = {}; state.events = [];
  logEvent('demo.reset', {});
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Rutas de contenido (/especialidades/*, /precios, /sucursales, etc.) sirven la landing,
// para que los vínculos a sitios de Google Ads no den 404 ("Destino no operativo").
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(CFG.port, () => {
  console.log(`RT4 DNI demo escuchando en :${CFG.port} | pool=${CFG.pool.join(',')} | google=${CFG.google.mode} meta=${CFG.meta.mode}`);
});

// server.js – Express + CORS + Google Calendar (CommonJS, con diagnóstico)
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CORS =====
const ALLOW_ALL = true;
const ALLOWED_ORIGINS = ['https://tudominio.com', 'https://www.tudominio.com'];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOW_ALL) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  } else if (ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Credentials', 'false');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// ===== Datos en memoria (demo) =====
const BOOKINGS = [];

const SERVICES_MINUTES = {
  corte_caballero: 30, corte_21dias: 30, corte_hasta20: 30, corte_al0: 15,
  corte_barba: 60, corte_barba_21dias: 60, corte_barba_al0: 30,
  barba: 30, cejas: 10, color_barba_barba: 30, color_pelo: 30
};

const STEP_MIN = 15;
const START_HOUR = 8;
const END_HOUR = 20;

const pad = n => ('0' + n).slice(-2);
const toDate = (dateISO, hhmm) => new Date(`${dateISO}T${hhmm}:00`);
const overlaps = (aStart, aEnd, bStart, bEnd) => (aStart < bEnd && bStart < aEnd);

// ===== Google Calendar Auth (acepta archivo o variable) =====
const GOOGLE_KEY_PATH = process.env.GOOGLE_KEY_PATH || '/etc/secrets/google.json';
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS; // JSON string opcional
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

let auth;
if (GOOGLE_CREDENTIALS) {
  // Credenciales en variable de entorno (JSON stringificado)
  const creds = JSON.parse(GOOGLE_CREDENTIALS);
  auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    SCOPES
  );
  console.log('Auth: usando GOOGLE_CREDENTIALS (env var).');
} else {
  auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_KEY_PATH,
    scopes: SCOPES,
  });
  console.log('Auth: usando keyFile:', GOOGLE_KEY_PATH);
}

const calendar = google.calendar({ version: 'v3', auth });

// ===== IDs de calendarios =====
const BARBER_CAL_IDS = {
  ana:   '9d0890541fd206d30695136ff8e5e4c89563117199c5d4bf3761f955d960fc42@group.calendar.google.com',
  luis:  '9c75a9a1d75ccebdc4eac6e4181c57fd1da1cabc30fa413e509749455cba70ec@group.calendar.google.com',
  marco: 'c439a5eb409549264f234d6b9929bd8cfd8d836570997cd450afdefb55097cfa@group.calendar.google.com'
};

// ===== Healthcheck =====
app.get('/', (req, res) => res.json({ ok: true, service: 'barberia-backend' }));

// Endpoint de prueba de inserción
app.get('/test-insert', async (req, res) => {
  try {
    const barber = (req.query.barber || 'ana').toLowerCase();
    const calId = BARBER_CAL_IDS[barber];
    if (!calId) return res.status(400).json({ ok:false, message:`Barbero desconocido: ${barber}` });

    const now = new Date();
    const end = new Date(now.getTime() + 30*60000);

    const event = {
      summary: 'TEST RESERVA',
      description: 'Evento de prueba insertado desde backend',
      start: { dateTime: now.toISOString(), timeZone: 'Europe/Madrid' },
      end:   { dateTime: end.toISOString(), timeZone: 'Europe/Madrid' }
    };

    const resp = await calendar.events.insert({ calendarId: calId, resource: event });
    return res.json({ ok:true, id: resp.data.id, htmlLink: resp.data.htmlLink });
  } catch (err) {
    const msg = extractGCalError(err);
    console.error('Error en /test-insert:', msg, fullErrForLogs(err));
    return res.status(500).json({ ok:false, message: msg });
  }
});

// ===== GET /slots =====
app.get('/slots', (req, res) => {
  const { date, barberId, serviceId } = req.query;
  if (!date || !barberId || !serviceId) {
    return res.status(400).json({ message: 'Faltan parámetros (date, barberId, serviceId)' });
  }

  const svcMin = SERVICES_MINUTES[serviceId] || 30;
  const start = new Date(`${date}T${pad(START_HOUR)}:00`);
  const end   = new Date(`${date}T${pad(END_HOUR)}:00`);

  const busy = BOOKINGS
    .filter(b => b.date === date && b.barberId === barberId)
    .map(b => {
      const s = toDate(b.date, b.time);
      const e = new Date(s.getTime() + (SERVICES_MINUTES[b.serviceId] || 30) * 60000);
      return { s, e };
    });

  const result = [];
  for (let t = new Date(start); t < end; t = new Date(t.getTime() + STEP_MIN * 60000)) {
    const slotStart = new Date(t);
    const slotEnd   = new Date(slotStart.getTime() + svcMin * 60000);
    if (slotEnd > end) break;
    const conflict = busy.some(b => overlaps(slotStart, slotEnd, b.s, b.e));
    if (!conflict) result.push(slotStart.toTimeString().slice(0, 5));
  }

  res.json({ slots: result });
});

// ===== POST /book =====
app.post('/book', async (req, res) => {
  try {
    const { date, time, barberId, serviceId, name, email, phone, notes } = req.body || {};
    if (!date || !time || !barberId || !serviceId || !name) {
      return res.status(400).json({ ok: false, message: 'Datos incompletos' });
    }

    const minutes = SERVICES_MINUTES[serviceId] || 30;
    const start = toDate(date, time);
    const end   = new Date(start.getTime() + minutes * 60000);

    const conflict = BOOKINGS.some(b => {
      if (b.date !== date || b.barberId !== barberId) return false;
      const s = toDate(b.date, b.time);
      const e = new Date(s.getTime() + (SERVICES_MINUTES[b.serviceId] || 30) * 60000);
      return overlaps(start, end, s, e);
    });
    if (conflict) return res.status(409).json({ ok: false, message: 'Hora no disponible' });

    BOOKINGS.push({ date, time, barberId, serviceId });

    // Insertar en Google Calendar
    const calId = BARBER_CAL_IDS[barberId];
    if (calId) {
      const event = {
        summary: `Reserva ${serviceId} – ${name}`,
        description: `Cliente: ${name}\nEmail: ${email || ''}\nTel: ${phone || ''}\nNotas: ${notes || ''}`,
        start: { dateTime: `${date}T${time}:00`, timeZone: 'Europe/Madrid' },
        end:   { dateTime: end.toISOString(), timeZone: 'Europe/Madrid' }
      };

      await calendar.events.insert({ calendarId: calId, resource: event });
    }

    res.json({ ok: true, message: 'Reserva creada y enviada a Google Calendar' });
  } catch (err) {
    const msg = extractGCalError(err);
    console.error('Error al crear evento en Google Calendar:', msg, fullErrForLogs(err));
    res.status(500).json({ ok: false, message: `Google Calendar: ${msg}` });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT} (TZ=${process.env.TZ || 'Europe/Madrid'})`);
});

// ===== Helpers de diagnóstico =====
function extractGCalError(err){
  // Intenta sacar el mensaje más útil de la respuesta de Google
  if (err && err.response && err.response.data && err.response.data.error) {
    const e = err.response.data.error;
    // ejemplos: 401 invalid credentials, 403 insufficientPermissions,
    // 404 notFound (ID calendario incorrecto), 400 invalidArgument, etc.
    return `${e.code} ${e.status || ''} ${e.message || ''}`.trim();
  }
  return err?.message || 'Error desconocido';
}
function fullErrForLogs(err){
  try { return JSON.stringify(err.response?.data || err, null, 2); }
  catch { return err; }
}

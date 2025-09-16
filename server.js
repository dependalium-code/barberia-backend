// server.js — Express + CORS + Google Calendar (CommonJS) — Slots desde Google Calendar
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const TZ = 'Europe/Madrid';

// ===== CORS =====
const ALLOW_ALL = true;
const ALLOWED_ORIGINS = ['https://tudominio.com', 'https://www.tudominio.com'];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOW_ALL) res.header('Access-Control-Allow-Origin', origin || '*');
  else if (ALLOWED_ORIGINS.includes(origin)) res.header('Access-Control-Allow-Origin', origin);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Credentials', 'false');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ===== Config negocio =====
const SERVICES_MINUTES = {
  corte_caballero: 30, corte_21dias: 30, corte_hasta20: 30, corte_al0: 15,
  corte_barba: 60, corte_barba_21dias: 60, corte_barba_al0: 30,
  barba: 30, cejas: 10, color_barba_barba: 30, color_pelo: 30
};
const STEP_MIN = 15;
const START_HOUR = 8;
const END_HOUR   = 20;
const OPEN_DOW_1TO7 = [1,2,3,4,5,6]; // L..S (Domingo=7 cerrado)
const pad = n => String(n).padStart(2,'0');
const toLocalDate = (dateISO, timeHHMM) => new Date(`${dateISO}T${timeHHMM}:00`);
const overlaps = (aS,aE,bS,bE) => (aS < bE && bS < aE);

// ===== Calendarios por barbero =====
const BARBER_CAL_IDS = {
  ana:   '9d0890541fd206d30695136ff8e5e4c89563117199c5d4bf3761f955d960fc42@group.calendar.google.com',
  luis:  '9c75a9a1d75ccebdc4eac6e4181c57fd1da1cabc30fa413e509749455cba70ec@group.calendar.google.com',
  marco: 'c439a5eb409549264f234d6b9929bd8cfd8d836570997cd450afdefb55097cfa@group.calendar.google.com'
};

// ===== Auth Google =====
const GOOGLE_KEY_PATH = process.env.GOOGLE_KEY_PATH || '/etc/secrets/google.json';
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

let auth;
if (GOOGLE_CREDENTIALS) {
  const creds = JSON.parse(GOOGLE_CREDENTIALS);
  auth = new google.auth.JWT(creds.client_email, null, creds.private_key, SCOPES);
  console.log('Auth: usando GOOGLE_CREDENTIALS (env var). SA:', creds.client_email);
} else if (fs.existsSync(GOOGLE_KEY_PATH)) {
  const raw = JSON.parse(fs.readFileSync(GOOGLE_KEY_PATH,'utf8'));
  auth = new google.auth.JWT(raw.client_email, null, raw.private_key, SCOPES);
  console.log('Auth: usando keyFile:', GOOGLE_KEY_PATH, 'SA:', raw.client_email);
} else {
  console.error('Auth: NO hay credenciales. Sube Secret File google.json o usa GOOGLE_CREDENTIALS.');
}
const calendar = google.calendar({ version: 'v3', auth });

// ===== Healthcheck =====
app.get('/', (req, res) => res.json({ ok: true, service: 'barberia-backend' }));

// ===== Diagnóstico: ver calendarios visibles por la Service Account =====
app.get('/diag/calendars', async (req, res) => {
  try {
    const list = await calendar.calendarList.list();
    const items = (list.data.items || []).map(c => ({ id: c.id, summary: c.summary, primary: !!c.primary }));
    res.json({ ok: true, calendars: items });
  } catch (err) {
    res.status(500).json({ ok:false, message: err.message, details: err.response?.data });
  }
});

// ===== Test insert =====
app.get('/test-insert', async (req, res) => {
  try {
    const barber = (req.query.barber || 'ana').toLowerCase();
    const calId = BARBER_CAL_IDS[barber];
    if (!calId) return res.status(400).json({ ok:false, message:`Barbero desconocido: ${barber}` });
    const now = new Date();
    const end = new Date(now.getTime() + 30*60000);
    const event = {
      summary: 'TEST RESERVA',
      description: 'Evento de prueba',
      start: { dateTime: now.toISOString(), timeZone: TZ },
      end:   { dateTime: end.toISOString(), timeZone: TZ }
    };
    const resp = await calendar.events.insert({ calendarId: calId, resource: event });
    res.json({ ok:true, id: resp.data.id, htmlLink: resp.data.htmlLink });
  } catch (err) {
    res.status(500).json({ ok:false, message: extractGCalError(err) });
  }
});

// ===== GET /slots — lee eventos de Google Calendar =====
// /slots?date=YYYY-MM-DD&barberId=ana&serviceId=corte_caballero
app.get('/slots', async (req, res) => {
  try {
    const { date, barberId, serviceId } = req.query;
    if (!date || !barberId || !serviceId) {
      return res.status(400).json({ message: 'Faltan parámetros (date, barberId, serviceId)' });
    }
    const calId = BARBER_CAL_IDS[barberId];
    if (!calId) return res.status(400).json({ message: 'barberId desconocido' });

    const svcMin = SERVICES_MINUTES[serviceId] || 30;

    // Día laboral y horario
    const d = new Date(`${date}T00:00:00`);
    const dow1to7 = ((d.getDay() + 6) % 7) + 1; // L=1..D=7
    if (!OPEN_DOW_1TO7.includes(dow1to7)) return res.json({ slots: [] });

    const dayStart = new Date(`${date}T${pad(START_HOUR)}:00:00`);
    const dayEnd   = new Date(`${date}T${pad(END_HOUR)}:00:00`);

    // Leer eventos ocupados del día
    const busy = await listBusyIntervals(calId, dayStart, dayEnd);

    // Generar slots
    const stepMs = STEP_MIN * 60 * 1000;
    const slots = [];
    const now = new Date();
    for (let t = new Date(dayStart); t < dayEnd; t = new Date(t.getTime() + stepMs)) {
      const slotStart = new Date(t);
      const slotEnd   = new Date(slotStart.getTime() + svcMin * 60000);
      if (slotEnd > dayEnd) break;

      // No ofrecer horas pasadas del mismo día
      if (sameDay(slotStart, now) && slotStart <= now) continue;

      const conflict = busy.some(b => overlaps(slotStart, slotEnd, b.start, b.end));
      if (!conflict) slots.push(slotStart.toTimeString().slice(0,5));
    }

    res.json({ slots });
  } catch (err) {
    console.error('Error /slots:', err.response?.data || err);
    res.status(500).json({ message: `Error al obtener slots: ${extractGCalError(err)}` });
  }
});

// ===== POST /book — crea evento en Google Calendar =====
// body: {date,time,barberId,serviceId,name,email?,phone?,notes?}
app.post('/book', async (req, res) => {
  try {
    const { date, time, barberId, serviceId, name, email, phone, notes } = req.body || {};
    if (!date || !time || !barberId || !serviceId || !name) {
      return res.status(400).json({ ok:false, message:'Datos incompletos' });
    }
    const calId = BARBER_CAL_IDS[barberId];
    if (!calId) return res.status(400).json({ ok:false, message:'barberId desconocido' });

    const minutes = SERVICES_MINUTES[serviceId] || 30;
    const start = toLocalDate(date, time);
    const end   = new Date(start.getTime() + minutes*60000);

    // Comprobar conflicto en GCal justo antes de crear
    const conflicts = await listBusyIntervals(calId, start, end);
    if (conflicts.length) {
      return res.status(409).json({ ok:false, message:'Hora no disponible' });
    }

    const event = {
      summary: `Reserva ${serviceId} – ${name}`,
      description: `Cliente: ${name}\nEmail: ${email || ''}\nTel: ${phone || ''}\nNotas: ${notes || ''}`,
      start: { dateTime: start.toISOString(), timeZone: TZ },
      end:   { dateTime: end.toISOString(), timeZone: TZ }
    };
    const created = await calendar.events.insert({ calendarId: calId, resource: event });
    res.json({ ok:true, message:'Reserva creada y enviada a Google Calendar', eventId: created.data.id });
  } catch (err) {
    console.error('Error /book:', err.response?.data || err);
    res.status(500).json({ ok:false, message:`Google Calendar: ${extractGCalError(err)}` });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT} (TZ=${process.env.TZ || TZ})`);
});

// ===== Helpers =====
function sameDay(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
function extractGCalError(err){
  if (err?.response?.data?.error) {
    const e = err.response.data.error;
    return `${e.code} ${e.status || ''} ${e.message || ''}`.trim();
  }
  return err?.message || 'Error';
}
async function listBusyIntervals(calendarId, from, to){
  // Trae eventos confirmados entre from..to; maneja paginación y all-day
  let items = [];
  let pageToken;
  do {
    const resp = await calendar.events.list({
      calendarId,
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      pageToken
    });
    items = items.concat(resp.data.items || []);
    pageToken = resp.data.nextPageToken;
  } while (pageToken);

  const intervals = [];
  for (const ev of items) {
    if (ev.status === 'cancelled') continue;
    // Si es todo el día, ocupa todo el día
    const s = ev.start?.dateTime ? new Date(ev.start.dateTime) : ev.start?.date ? new Date(ev.start.date+'T00:00:00') : null;
    const e = ev.end?.dateTime   ? new Date(ev.end.dateTime)   : ev.end?.date   ? new Date(ev.end.date  +'T23:59:59') : null;
    if (!s || !e) continue;
    intervals.push({ start: s, end: e });
  }
  return intervals;
}

// server.js
// Backend citas barbería – Express + Google Calendar
//
// Rutas:
//  GET  /            -> ping (Backend ok)
//  GET  /slots       -> horas libres por barbero (query: date, barberId, serviceId)
//  POST /book        -> crear evento (body: date, time, barberId, serviceId, name, email?, phone?, notes?)
//
// Env vars necesarias (Render -> Environment):
//  GOOGLE_CLIENT_ID
//  GOOGLE_CLIENT_SECRET
//  GOOGLE_REFRESH_TOKEN
//  CAL_LUIS, CAL_ANA, CAL_MARCO
//  (opcional) TZ=Europe/Madrid
//
// package.json debe incluir "googleapis", "express", "cors"

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();

// ====== CORS ======
app.use(
  cors({
    origin: ['https://labarberiamataro.com', 'https://www.labarberiamataro.com'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  })
);
app.options('*', cors());

app.use(express.json());

// ====== CONFIG BÁSICA ======
const TIMEZONE = process.env.TZ || 'Europe/Madrid';

// horario tienda
const OPEN_DAYS = [1, 2, 3, 4, 5, 6]; // L=1 ... S=6 (Domingo cerrado)
const START_HOUR = 8;                 // 08:00
const END_HOUR = 20;                  // 20:00
const STEP_MIN = 15;                  // granulado de agenda

// servicios (ids deben coincidir con el frontend)
const SERVICES = {
  corte_caballero: 30,
  corte_21dias: 30,
  corte_hasta20: 30,
  corte_al0: 15,
  corte_barba: 60,
  corte_barba_21dias: 60,
  corte_barba_al0: 30,
  barba: 30,
  cejas: 10,
  color_barba_barba: 30,
  color_pelo: 30,
};

// barberos -> calendario
const BARBERS = {
  ana: process.env.CAL_ANA,
  luis: process.env.CAL_LUIS,
  marco: process.env.CAL_MARCO,
};

// ====== GOOGLE AUTH ======
function getOAuth2Client() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Faltan credenciales de Google en variables de entorno.');
  }
  const oAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oAuth2Client;
}

// ====== HELPERS FECHA/HORA ======
const pad2 = (n) => String(n).padStart(2, '0');

function parseISODate(dateISO) {
  const [y, m, d] = dateISO.split('-').map((v) => parseInt(v, 10));
  return new Date(y, m - 1, d);
}

function isOpenDay(dateISO) {
  const d = parseISODate(dateISO);
  const dow = d.getDay(); // 0=Dom ... 6=Sáb
  // convertir a 1..6 (L..S), Domingo 0 no está en OPEN_DAYS
  const dowMon1 = dow === 0 ? 0 : dow; // L=1 ... D=0
  return OPEN_DAYS.includes(dowMon1);
}

function toRFC3339(dateISO, hhmm) {
  // Construye "YYYY-MM-DDTHH:MM:00" y deja que Calendar lo interprete con timeZone
  return `${dateISO}T${hhmm}:00`;
}

function addMinutes(dateObj, minutes) {
  return new Date(dateObj.getTime() + minutes * 60000);
}

function hhmmAddMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map((v) => parseInt(v, 10));
  const ref = new Date(2000, 0, 1, h, m, 0);
  const end = addMinutes(ref, minutes);
  return `${pad2(end.getHours())}:${pad2(end.getMinutes())}`;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Convierte 'HH:MM' de un día dado a Date
function hhmmToDate(dateISO, hhmm) {
  const [h, m] = hhmm.split(':').map((v) => parseInt(v, 10));
  const d = parseISODate(dateISO);
  d.setHours(h, m, 0, 0);
  return d;
}

// ====== GOOGLE CALENDAR: eventos ocupados ======
async function getBusyBlocks(calendarId, dateISO) {
  // timeMin 00:00 local, timeMax 23:59:59 local – usamos zona local para crear fechas,
  // luego toISOString (UTC) para enviar a la API.
  const dayStart = hhmmToDate(dateISO, '00:00');
  const dayEnd = hhmmToDate(dateISO, '23:59');

  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.list({
    calendarId,
    timeMin: dayStart.toISOString(),
    timeMax: addMinutes(dayEnd, 59).toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = res.data.items || [];
  const blocks = [];

  for (const ev of events) {
    const s = ev.start;
    const e = ev.end;
    let startDate, endDate;

    if (s.dateTime) {
      startDate = new Date(s.dateTime);
    } else if (s.date) {
      // evento de día completo
      startDate = hhmmToDate(s.date, '00:00');
    }

    if (e.dateTime) {
      endDate = new Date(e.dateTime);
    } else if (e.date) {
      // all-day termina al día siguiente 00:00; lo tomamos como 23:59 del día anterior
      endDate = hhmmToDate(e.date, '00:00'); // comienzo del siguiente día
    }

    if (startDate && endDate) {
      blocks.push({ start: startDate, end: endDate, summary: ev.summary || '' });
    }
  }

  return blocks;
}

// ====== GENERADOR DE SLOTS ======
function generateSlotsForDay(dateISO, minutes) {
  const slots = [];
  const start = new Date(parseISODate(dateISO));
  start.setHours(START_HOUR, 0, 0, 0);

  const endLimit = new Date(parseISODate(dateISO));
  endLimit.setHours(END_HOUR, 0, 0, 0);

  for (let t = new Date(start); t < endLimit; t = addMinutes(t, STEP_MIN)) {
    const slotStart = new Date(t);
    const slotEnd = addMinutes(slotStart, minutes);
    if (slotEnd > endLimit) break;
    slots.push(`${pad2(slotStart.getHours())}:${pad2(slotStart.getMinutes())}`);
  }
  return slots;
}

async function getAvailableSlots(calendarId, dateISO, serviceMinutes) {
  // 1) si el día no es laborable -> []
  if (!isOpenDay(dateISO)) return [];

  // 2) bloques ocupados del calendario
  const busy = await getBusyBlocks(calendarId, dateISO);

  // 3) slots candidatos
  const candidates = generateSlotsForDay(dateISO, serviceMinutes);

  // 4) filtrado por solapes
  const free = [];
  for (const hhmm of candidates) {
    const s = hhmmToDate(dateISO, hhmm);
    const e = addMinutes(s, serviceMinutes);

    const conflict = busy.some((b) => overlaps(s, e, b.start, b.end));
    if (!conflict) free.push(hhmm);
  }

  return free;
}

// ====== RUTAS ======

// Ping
app.get('/', (_req, res) => {
  res.type('text/plain').send('Backend ok ✅');
});

// Slots
// /slots?date=YYYY-MM-DD&barberId=luis&serviceId=corte_caballero
app.get('/slots', async (req, res) => {
  try {
    const { date, barberId, serviceId } = req.query;

    if (!date || !barberId || !serviceId) {
      return res.status(400).json({ ok: false, message: 'Faltan parámetros (date, barberId, serviceId).' });
    }
    const calId = BARBERS[barberId];
    if (!calId) return res.status(400).json({ ok: false, message: 'Barbero desconocido.' });

    const minutes = SERVICES[serviceId];
    if (!minutes) return res.status(400).json({ ok: false, message: 'Servicio desconocido.' });

    const slots = await getAvailableSlots(calId, date, minutes);
    res.json({ ok: true, slots });
  } catch (err) {
    console.error('Error /slots:', err?.response?.data || err.message || err);
    res.status(500).json({ ok: false, message: 'Error obteniendo slots.' });
  }
});

// Book
// body: { date, time, barberId, serviceId, name, email?, phone?, notes? }
app.post('/book', async (req, res) => {
  try {
    const { date, time, barberId, serviceId, name, email, phone, notes } = req.body || {};

    if (!date || !time || !barberId || !serviceId || !name) {
      return res.status(400).json({ ok: false, message: 'Faltan campos obligatorios.' });
    }
    const calId = BARBERS[barberId];
    if (!calId) return res.status(400).json({ ok: false, message: 'Barbero desconocido.' });

    const minutes = SERVICES[serviceId];
    if (!minutes) return res.status(400).json({ ok: false, message: 'Servicio desconocido.' });

    // Validación anti-solape en el momento de reservar:
    const startHHMM = time;
    const endHHMM = hhmmAddMinutes(time, minutes);
    const startDate = hhmmToDate(date, startHHMM);
    const endDate = hhmmToDate(date, endHHMM);

    const busy = await getBusyBlocks(calId, date);
    const conflict = busy.some((b) => overlaps(startDate, endDate, b.start, b.end));
    if (conflict) return res.status(409).json({ ok: false, message: 'Esa franja ya está ocupada.' });

    const auth = getOAuth2Client();
    const calendar = google.calendar({ version: 'v3', auth });

    const event = {
      summary: `Cita ${name}`,
      description:
        `Servicio: ${serviceId}\nCliente: ${name}\nEmail: ${email || ''}\nTeléfono: ${phone || ''}\nNotas: ${notes || ''}`,
      start: {
        dateTime: toRFC3339(date, startHHMM),
        timeZone: TIMEZONE,
      },
      end: {
        dateTime: toRFC3339(date, endHHMM),
        timeZone: TIMEZONE,
      },
    };

    await calendar.events.insert({
      calendarId: calId,
      resource: event,
      sendUpdates: 'none',
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Error /book:', err?.response?.data || err.message || err);
    res.status(500).json({ ok: false, message: 'No se pudo crear la reserva.' });
  }
});

// ====== START ======
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend escuchando en http://localhost:${PORT}`);
});

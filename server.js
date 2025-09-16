// server.js — Backend Barbería con Google Calendar
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { google } from "googleapis";

// ====== CONFIGURACIÓN ======
const TZ = process.env.TZ || "Europe/Madrid";

// Horario de trabajo y granularidad
const OPEN_DAYS = [1, 2, 3, 4, 5, 6];   // Lunes(1) ... Sábado(6) — Domingo(0) cerrado
const START_HOUR = Number(process.env.START_HOUR || 9);
const END_HOUR   = Number(process.env.END_HOUR   || 20);
const STEP_MIN   = Number(process.env.STEP_MIN   || 15);

// Mapa de servicios (id → minutos)  **DEBE COINCIDIR** con el front
const SERVICE_MINUTES = {
  corte_caballero:    30,
  corte_21dias:       30,
  corte_hasta20:      30,
  corte_al0:          15,
  corte_barba:        60,
  corte_barba_21dias: 60,
  corte_barba_al0:    30,
  barba:              30,
  cejas:              10,
  color_barba_barba:  30,
  color_pelo:         30
};

// Mapa barbero → calendario (puedes pasar un JSON en BARBER_CALENDAR_JSON o variables CAL_LUIS, CAL_ANA, CAL_MARCO)
let BARBER_CALENDAR = {};
try {
  if (process.env.BARBER_CALENDAR_JSON) {
    BARBER_CALENDAR = JSON.parse(process.env.BARBER_CALENDAR_JSON);
  } else {
    BARBER_CALENDAR = {
      luis:  process.env.CAL_LUIS  || "",
      ana:   process.env.CAL_ANA   || "",
      marco: process.env.CAL_MARCO || ""
    };
  }
} catch (_) {}

// Orígenes permitidos (WordPress). Para pruebas puedes dejarlo abierto.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// Google OAuth2 (usar refresh token)
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground" // no se usa en servidor, pero es el habitual
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const calendar = google.calendar({ version: "v3", auth: oauth2Client });

// ====== APP ======
const app = express();
app.use(bodyParser.json());
app.use(cors({
  origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN.split(",").map(s => s.trim()),
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.options("*", cors());

// Logs útiles
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Sanity check
app.get("/", (_req, res) => res.send("Backend ok ✅"));

// ====== HELPERS ======
const pad = n => ("0" + n).slice(-2);
const toISODate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const sameDay = (a,b) => a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();

function dateFrom(dateISO, hhmm) { // "2025-09-16" + "10:30" -> Date local
  const [H,M] = hhmm.split(":").map(Number);
  const d = new Date(dateISO + "T00:00:00");
  d.setHours(H, M, 0, 0);
  return d;
}

function toRFC3339(d) { // -> string con TZ correcta
  // Google admite dateTime + timeZone. Usaremos dateTime en ISO y le pasamos timeZone por separado
  return d.toISOString();
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Obtiene intervalos ocupados de un calendario en una fecha
async function getBusyIntervals(calendarId, dateISO) {
  const dayStart = new Date(dateISO + "T00:00:00");
  const dayEnd   = new Date(dateISO + "T23:59:59");

  const { data } = await calendar.events.list({
    calendarId,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    timeZone: TZ,
    maxResults: 2500
  });

  const events = data.items || [];
  const busy = [];
  for (const ev of events) {
    // evento de día completo?
    if (ev.start?.date && ev.end?.date) {
      const s = new Date(ev.start.date + "T00:00:00");
      const e = new Date(ev.end.date + "T00:00:00");
      busy.push({ start: s, end: e });
    } else {
      const s = ev.start?.dateTime ? new Date(ev.start.dateTime) : null;
      const e = ev.end?.dateTime   ? new Date(ev.end.dateTime)   : null;
      if (s && e) busy.push({ start: s, end: e });
    }
  }
  return busy;
}

// Genera slots libres dados los ocupados, duración servicio, horario y step
function buildSlotsForDay({ dateISO, busy, serviceMin }) {
  const res = [];
  const start = new Date(dateISO + "T00:00:00");
  start.setHours(START_HOUR, 0, 0, 0);
  const end = new Date(dateISO + "T00:00:00");
  end.setHours(END_HOUR, 0, 0, 0);

  const stepMs = STEP_MIN * 60 * 1000;
  const serviceMs = serviceMin * 60 * 1000;
  const now = new Date();

  for (let t = new Date(start); t < end; t = new Date(t.getTime() + stepMs)) {
    const slotStart = new Date(t);
    const slotEnd = new Date(slotStart.getTime() + serviceMs);
    if (slotEnd > end) break;

    // no ofrecer en pasado si es hoy
    if (sameDay(slotStart, now) && slotStart < now) continue;

    const conflict = busy.some(b => overlaps(slotStart, slotEnd, b.start, b.end));
    if (!conflict) res.push(`${pad(slotStart.getHours())}:${pad(slotStart.getMinutes())}`);
  }
  return res;
}

// ====== /slots ======
app.get("/slots", async (req, res) => {
  try {
    const dateISO   = (req.query.date || "").trim();       // YYYY-MM-DD
    const barberId  = (req.query.barberId || "").trim();   // luis | ana | marco
    const serviceId = (req.query.serviceId || "").trim();  // id del servicio

    if (!dateISO || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
      return res.status(400).json({ ok:false, message: "Parámetro 'date' (YYYY-MM-DD) requerido" });
    }
    const day = new Date(dateISO + "T00:00:00");
    const weekDay = day.getDay(); // 0-6 (0=Dom)
    if (!OPEN_DAYS.includes(weekDay)) {
      return res.json({ ok:true, slots: [] }); // cerrado
    }

    const calendarId = BARBER_CALENDAR[barberId];
    if (!calendarId) {
      return res.status(400).json({ ok:false, message: "barberId inválido" });
    }

    const serviceMin = SERVICE_MINUTES[serviceId] || 30;
    const busy = await getBusyIntervals(calendarId, dateISO);
    const slots = buildSlotsForDay({ dateISO, busy, serviceMin });

    res.json({ ok:true, slots });
  } catch (e) {
    console.error("Error /slots:", e);
    res.status(500).json({ ok:false, message: "Error interno en /slots" });
  }
});

// ====== /book ======
app.post("/book", async (req, res) => {
  try {
    const { date, time, barberId, serviceId, name, email, phone, notes } = req.body || {};
    if (!date || !time || !barberId || !serviceId || !name) {
      return res.status(400).json({ ok:false, message: "Faltan campos obligatorios (date,time,barberId,serviceId,name)" });
    }

    const calendarId = BARBER_CALENDAR[barberId];
    if (!calendarId) return res.status(400).json({ ok:false, message: "barberId inválido" });

    const serviceMin = SERVICE_MINUTES[serviceId] || 30;
    const slotStart = dateFrom(date, time);
    const slotEnd   = new Date(slotStart.getTime() + serviceMin*60*1000);

    // Re-chequear solape (por si entre /slots y /book alguien reservó)
    const busy = await getBusyIntervals(calendarId, date);
    const conflict = busy.some(b => overlaps(slotStart, slotEnd, b.start, b.end));
    if (conflict) return res.status(409).json({ ok:false, message: "La franja ya está ocupada" });

    // Crear evento
    const serviceName = Object.keys(SERVICE_MINUTES).includes(serviceId) ? serviceId : "Servicio";
    const summary = `Reserva: ${serviceName} – ${name}`;
    const description =
      `Cliente: ${name}\n` +
      (email ? `Email: ${email}\n` : "") +
      (phone ? `Tel: ${phone}\n` : "") +
      (notes ? `Notas: ${notes}\n` : "") +
      `Barbero: ${barberId}`;

    const newEvent = {
      calendarId,
      resource: {
        summary,
        description,
        start: { dateTime: toRFC3339(slotStart), timeZone: TZ },
        end:   { dateTime: toRFC3339(slotEnd),   timeZone: TZ }
      }
    };

    await calendar.events.insert(newEvent);

    res.json({ ok:true });
  } catch (e) {
    console.error("Error /book:", e?.response?.data || e);
    res.status(500).json({ ok:false, message: "Error interno al crear la reserva" });
  }
});

// ====== START ======
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT} (TZ=${TZ})`);
});

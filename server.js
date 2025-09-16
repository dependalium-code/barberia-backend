import express from "express";
import cors from "cors";
import { google } from "googleapis";

const PORT = process.env.PORT || 3000;
const TIMEZONE = "Europe/Madrid";

const CALENDARS = {
  luis:  "9c75a9a1d75ccebdc4eac6e4181c57fd1da1cabc30fa413e509749455cba70ec@group.calendar.google.com",
  ana:   "9d0890541fd206d30695136ff8e5e4c89563117199c5d4bf3761f955d960fc42@group.calendar.google.com",
  marco: "c439a5eb409549264f234d6b9929bd8cfd8d836570997cd450afdefb55097cfa@group.calendar.google.com"
};

const OPEN_DAYS = [1,2,3,4,5,6];
const START_HOUR = 8;
const END_HOUR = 20;
const STEP_MINUTES = 15;

const SERVICES = [
  { id: 'corte_caballero',    minutes: 30, price: 24.00,  name: 'Corte caballero' },
  { id: 'corte_21dias',       minutes: 30, price: 18.00,  name: 'Corte (21 días)' },
  { id: 'corte_hasta20',      minutes: 30, price: 19.50,  name: 'Corte hasta 20 años' },
  { id: 'corte_al0',          minutes: 15, price: 15.00,  name: 'Corte al 0' },
  { id: 'corte_barba',        minutes: 60, price: 33.00,  name: 'Corte + barba' },
  { id: 'corte_barba_21dias', minutes: 60, price: 29.50,  name: 'Arreglo corte + barba (21 días)' },
  { id: 'corte_barba_al0',    minutes: 30, price: 26.00,  name: 'Corte + barba al 0' },
  { id: 'barba',              minutes: 30, price: 15.00,  name: 'Barba' },
  { id: 'cejas',              minutes: 10, price: 6.00,   name: 'Cejas' },
  { id: 'color_barba_barba',  minutes: 30, price: 30.00,  name: 'Color barba + barba' },
  { id: 'color_pelo',         minutes: 30, price: 15.00,  name: 'Color de pelo' }
];

// OAuth2
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const REDIRECT_URI  = "https://developers.google.com/oauthplayground";

function getOAuthClient() {
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  return oAuth2Client;
}

// Utils
const pad = n => ('0'+n).slice(-2);
const parseYMD = (ymd) => { const [y,m,d]=ymd.split('-').map(Number); return new Date(y, m-1, d); };
const minutesToMs = (m) => m*60000;
const sameDay = (a,b) => a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
const overlaps = (aStart,aEnd,bStart,bEnd) => aStart < bEnd && bStart < aEnd;

function* generateStartTimes(date) {
  const dow = (date.getDay()+6)%7 + 1; // 1..7 lunes=1
  if (!OPEN_DAYS.includes(dow)) return;
  const start = new Date(date); start.setHours(START_HOUR,0,0,0);
  const end   = new Date(date); end.setHours(END_HOUR,0,0,0);
  for (let t=new Date(start); t<end; t = new Date(t.getTime()+STEP_MINUTES*60000)) {
    yield new Date(t);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_,res)=>res.json({ok:true}));

// GET slots
app.get("/", async (req, res) => {
  try {
    const { fn, date, barberId, serviceId } = req.query;
    if (fn !== "slots") return res.status(400).json({ ok:false, message:"fn inválida" });

    const calendarId = CALENDARS[String(barberId)];
    const svc = SERVICES.find(s => s.id === String(serviceId));
    if (!calendarId || !svc) return res.status(400).json({ ok:false, message:"Datos inválidos" });

    const auth = getOAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    const dateObj = parseYMD(String(date));
    const timeMin = new Date(dateObj); timeMin.setHours(0,0,0,0);
    const timeMax = new Date(dateObj); timeMax.setHours(23,59,59,999);

    const fb = await calendar.freebusy.query({
      requestBody: { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), timeZone: TIMEZONE, items: [{ id: calendarId }] }
    });
    const busyRanges = (fb.data.calendars?.[calendarId]?.busy || []).map(b => ({ start:new Date(b.start), end:new Date(b.end) }));

    const now = new Date();
    const slots = [];
    for (const start of generateStartTimes(dateObj)) {
      const end = new Date(start.getTime() + minutesToMs(svc.minutes));
      const dayEnd = new Date(dateObj); dayEnd.setHours(END_HOUR,0,0,0);
      if (end > dayEnd) continue;
      if (sameDay(dateObj, now) && start <= now) continue;
      const conflict = busyRanges.some(b => overlaps(start,end,b.start,b.end));
      if (!conflict) slots.push(`${pad(start.getHours())}:${pad(start.getMinutes())}`);
    }
    res.json({ ok:true, slots });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, message:"Error obteniendo slots" });
  }
});

// POST book
app.post("/", async (req, res) => {
  try {
    const url = new URL(req.originalUrl, `http://${req.headers.host}`);
    const fn = url.searchParams.get("fn");
    if (fn !== "book") return res.status(400).json({ ok:false, message:"fn inválida" });

    const { date, time, barberId, serviceId, name, email, phone, notes } = req.body || {};
    const calendarId = CALENDARS[String(barberId)];
    const svc = SERVICES.find(s => s.id === String(serviceId));
    if (!calendarId || !svc || !date || !time || !name) return res.status(400).json({ ok:false, message:"Datos inválidos" });

    const [hh, mm] = String(time).split(":").map(Number);
    const d = parseYMD(String(date));
    const start = new Date(d); start.setHours(hh, mm||0, 0, 0);
    const end   = new Date(start.getTime() + minutesToMs(svc.minutes));

    const auth = getOAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    const fb = await calendar.freebusy.query({
      requestBody: { timeMin: start.toISOString(), timeMax: end.toISOString(), timeZone: TIMEZONE, items: [{ id: calendarId }] }
    });
    if ((fb.data.calendars?.[calendarId]?.busy || []).length) {
      return res.status(409).json({ ok:false, message:"Franja ocupada, elige otra hora." });
    }

    const summary = `${svc.name} – ${name}`;
    const description = [
      `Servicio: ${svc.name} (${svc.minutes} min, ${svc.price.toFixed(2)} €)`,
      name  ? `Cliente: ${name}` : "",
      phone ? `Tel.: ${phone}`   : "",
      notes ? `Notas: ${notes}`  : ""
    ].filter(Boolean).join("\n");

    const attendees = [];
    if (email) attendees.push({ email, displayName: name });

    const ev = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary,
        description,
        start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
        end:   { dateTime: end.toISOString(),   timeZone: TIMEZONE },
        attendees,
        transparency: "opaque",
        reminders: { useDefault: false, overrides: [{ method:"popup", minutes:10 }] }
      },
      sendUpdates: email ? "all" : "none"
    });

    res.json({ ok:true, id: ev.data.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, message:"No se pudo crear la reserva" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Backend listo en http://localhost:${PORT}`);
});

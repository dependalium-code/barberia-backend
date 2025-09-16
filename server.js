// server.js (diagnóstico + Google Calendar)
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();

// ===== CORS (abierto temporalmente para probar) =====
app.use(cors({ origin: true, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

// ===== CONFIG =====
const TIMEZONE = process.env.TZ || 'Europe/Madrid';
const OPEN_DAYS = [1,2,3,4,5,6]; // L-S; domingo cerrado
const START_HOUR = 8;
const END_HOUR = 20;
const STEP_MIN = 15;

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
  color_pelo: 30
};

const BARBERS = {
  ana:   process.env.CAL_ANA || '',
  luis:  process.env.CAL_LUIS || '',
  marco: process.env.CAL_MARCO || ''
};

// ===== LOGS SIMPLES =====
app.use((req,res,next)=>{
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ===== HELPERS =====
const pad2 = n => String(n).padStart(2,'0');
const overlaps = (aStart, aEnd, bStart, bEnd) => (aStart < bEnd && bStart < aEnd);

function parseISODate(dateISO){ const [y,m,d]=dateISO.split('-').map(Number); return new Date(y,m-1,d); }
function hhmmToDate(dateISO, hhmm){ const [H,M]=hhmm.split(':').map(Number); const d=parseISODate(dateISO); d.setHours(H,M,0,0); return d; }
function addMinutes(dateObj, minutes){ return new Date(dateObj.getTime()+minutes*60000); }
function isOpenDay(dateISO){ const dow=parseISODate(dateISO).getDay(); return OPEN_DAYS.includes(dow); }

function getOAuth2Client(){
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN){
    throw new Error('Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN');
  }
  const oAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oAuth2Client;
}

async function getBusyBlocks(calendarId, dateISO){
  const dayStart = hhmmToDate(dateISO, '00:00');
  const dayEnd   = hhmmToDate(dateISO, '23:59');
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.list({
    calendarId,
    timeMin: dayStart.toISOString(),
    timeMax: addMinutes(dayEnd, 59).toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: TIMEZONE
  });

  const events = res.data.items || [];
  const blocks = [];
  for (const ev of events){
    let s=null,e=null;
    if (ev.start?.dateTime){ s=new Date(ev.start.dateTime); }
    else if (ev.start?.date){ s=hhmmToDate(ev.start.date,'00:00'); }
    if (ev.end?.dateTime){ e=new Date(ev.end.dateTime); }
    else if (ev.end?.date){ e=hhmmToDate(ev.end.date,'00:00'); }
    if (s && e) blocks.push({ start:s, end:e });
  }
  return blocks;
}

function generateSlotsForDay(dateISO, minutes){
  const out = [];
  const start = parseISODate(dateISO); start.setHours(START_HOUR,0,0,0);
  const end   = parseISODate(dateISO); end.setHours(END_HOUR,0,0,0);
  for (let t=new Date(start); t<end; t=addMinutes(t, STEP_MIN)){
    const slotStart=new Date(t);
    const slotEnd=addMinutes(slotStart, minutes);
    if (slotEnd> end) break;
    out.push(`${pad2(slotStart.getHours())}:${pad2(slotStart.getMinutes())}`);
  }
  return out;
}

// ===== ENDPOINTS =====
app.get('/health', (req,res)=> res.json({ ok:true, time:new Date().toISOString() }));

// Muestra qué variables están cargadas (sin revelar secretos)
app.get('/env-check', (req,res)=>{
  const mask = v => v ? '✔︎' : '✖︎';
  res.json({
    ok:true,
    TZ: TIMEZONE,
    GOOGLE_CLIENT_ID: mask(process.env.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: mask(process.env.GOOGLE_CLIENT_SECRET),
    GOOGLE_REFRESH_TOKEN: mask(process.env.GOOGLE_REFRESH_TOKEN),
    CAL_ANA: BARBERS.ana ? '✔︎ '+BARBERS.ana : '✖︎',
    CAL_LUIS: BARBERS.luis ? '✔︎ '+BARBERS.luis : '✖︎',
    CAL_MARCO: BARBERS.marco ? '✔︎ '+BARBERS.marco : '✖︎'
  });
});

// Ping
app.get('/', (req,res)=> res.type('text/plain').send('Backend ok ✅'));

// GET /slots?date=YYYY-MM-DD&barberId=luis&serviceId=corte_caballero
app.get('/slots', async (req,res)=>{
  try{
    const { date, barberId, serviceId } = req.query;
    if (!date || !barberId || !serviceId) return res.status(400).json({ ok:false, message:'Faltan parámetros (date, barberId, serviceId)' });

    const calId = BARBERS[barberId];
    if (!calId) return res.status(400).json({ ok:false, message:`Barbero desconocido: ${barberId}` });

    const minutes = SERVICES[serviceId];
    if (!minutes) return res.status(400).json({ ok:false, message:`Servicio desconocido: ${serviceId}` });

    if (!isOpenDay(date)) return res.json({ ok:true, slots: [] });

    const busy = await getBusyBlocks(calId, date);
    const candidates = generateSlotsForDay(date, minutes);

    // filtra solapes y pasado si es hoy
    const now = new Date();
    const slots = candidates.filter(hhmm=>{
      const s = hhmmToDate(date, hhmm);
      const e = addMinutes(s, minutes);
      if (parseISODate(date).toDateString()===now.toDateString() && s<now) return false;
      return !busy.some(b=>overlaps(s,e,b.start,b.end));
    });

    res.json({ ok:true, slots });
  } catch(err){
    console.error('Error /slots:', err?.response?.data || err);
    res.status(500).json({ ok:false, message:'Error interno en /slots', detail: String(err.message||err) });
  }
});

// POST /book  body:{ date,time,barberId,serviceId,name,email?,phone?,notes? }
app.post('/book', async (req,res)=>{
  try{
    const { date, time, barberId, serviceId, name, email, phone, notes } = req.body || {};
    if (!date || !time || !barberId || !serviceId || !name) return res.status(400).json({ ok:false, message:'Faltan campos obligatorios' });

    const calId = BARBERS[barberId];
    if (!calId) return res.status(400).json({ ok:false, message:`Barbero desconocido: ${barberId}` });

    const minutes = SERVICES[serviceId];
    if (!minutes) return res.status(400).json({ ok:false, message:`Servicio desconocido: ${serviceId}` });

    const start = hhmmToDate(date, time);
    const end   = addMinutes(start, minutes);

    // re-chequea solape
    const busy = await getBusyBlocks(calId, date);
    if (busy.some(b=>overlaps(start,end,b.start,b.end))){
      return res.status(409).json({ ok:false, message:'La franja ya está ocupada' });
    }

    const auth = getOAuth2Client();
    const calendar = google.calendar({ version:'v3', auth });

    await calendar.events.insert({
      calendarId: calId,
      resource: {
        summary: `Cita ${name}`,
        description: `Servicio: ${serviceId}\nCliente: ${name}\nEmail: ${email||''}\nTel: ${phone||''}\nNotas: ${notes||''}\nBarbero: ${barberId}`,
        start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
        end:   { dateTime: end.toISOString(),   timeZone: TIMEZONE }
      },
      sendUpdates: 'none'
    });

    res.json({ ok:true });
  } catch(err){
    console.error('Error /book:', err?.response?.data || err);
    res.status(500).json({ ok:false, message:'Error interno al crear la reserva', detail: String(err.message||err) });
  }
});

// ===== START =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log(`Backend escuchando en http://localhost:${PORT}`));

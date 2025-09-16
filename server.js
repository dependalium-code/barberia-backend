// server.js (Node 18+, type:module)
import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';

const app = express();
app.use(cors({
  origin: ['https://TU-DOMINIO-WORDPRESS.com','https://www.TU-DOMINIO-WORDPRESS.com'],
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.options('*', cors());
app.use(express.json());

// ---- Google OAuth client ----
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// ---- Config ----
const TZ = 'Europe/Madrid';
const STEP_MINUTES = 15;

const SERVICES = {
  corte_caballero:    { minutes: 30, price: 24.00 },
  corte_21dias:       { minutes: 30, price: 18.00 },
  corte_hasta20:      { minutes: 30, price: 19.50 },
  corte_al0:          { minutes: 15, price: 15.00 },
  corte_barba:        { minutes: 60, price: 33.00 },
  corte_barba_21dias: { minutes: 60, price: 29.50 },
  corte_barba_al0:    { minutes: 30, price: 26.00 },
  barba:              { minutes: 30, price: 15.00 },
  cejas:              { minutes: 10, price: 6.00  },
  color_barba_barba:  { minutes: 30, price: 30.00 },
  color_pelo:         { minutes: 30, price: 15.00 }
};

// Usa los IDs de calendario que me diste:
const CALS = {
  ana:   process.env.CAL_ANA,   // 9d0890...fc42@group.calendar.google.com
  luis:  process.env.CAL_LUIS,  // 9c75a9...70ec@group.calendar.google.com
  marco: process.env.CAL_MARCO  // c439a5...7cfa@group.calendar.google.com
};

// ---- Helpers ----
const pad = n => ('0' + n).slice(-2);
function overlaps(aStart, aEnd, bStart, bEnd){ return (aStart < bEnd && bStart < aEnd); }
function hhmm(d){ return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

// ---- Endpoints ----
app.get('/health', (req,res)=> res.json({ ok:true }));

// GET /slots?date=YYYY-MM-DD&barberId=luis&serviceId=corte_caballero
async function slotsHandler(req,res){
  try{
    const { date, barberId, serviceId } = req.query;
    const calId = CALS[barberId];
    const svc = SERVICES[serviceId] || { minutes: 30 };
    if (!date || !calId) return res.status(400).json({ ok:false, message:'Parámetros inválidos' });

    const startDay = new Date(`${date}T08:00:00`);
    const endDay   = new Date(`${date}T20:00:00`);
    // Consulta busy del día
    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: startDay.toISOString(),
        timeMax: endDay.toISOString(),
        timeZone: TZ,
        items: [{ id: calId }]
      }
    });
    const busy = (fb.data.calendars?.[calId]?.busy) || [];
    // Genera slots
    const stepMs = STEP_MINUTES*60*1000;
    const slots = [];
    for (let t = new Date(startDay); t < endDay; t = new Date(t.getTime()+stepMs)) {
      const slotStart = new Date(t);
      const slotEnd   = new Date(slotStart.getTime() + svc.minutes*60000);
      if (slotEnd > endDay) break;
      const conflict = busy.some(b => {
        const bStart = new Date(b.start);
        const bEnd   = new Date(b.end);
        return overlaps(slotStart, slotEnd, bStart, bEnd);
      });
      if (!conflict) slots.push(hhmm(slotStart));
    }
    return res.json({ ok:true, slots });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, message:'Error slots' });
  }
}
app.get('/slots', slotsHandler);
app.get('/', (req,res) => (req.query.fn==='slots' ? slotsHandler(req,res) : res.status(404).json({ok:false,message:'Not found'}) ));

// POST /book  JSON: { date,time,barberId,serviceId,name,email,phone,notes }
async function bookHandler(req,res){
  try{
    const { date, time, barberId, serviceId, name, email, phone, notes } = req.body || {};
    const calId = CALS[barberId];
    const svc = SERVICES[serviceId] || { minutes: 30 };
    if (!date || !time || !calId) return res.status(400).json({ ok:false, message:'Parámetros inválidos' });

    const start = new Date(`${date}T${time}:00`);
    const end   = new Date(start.getTime() + svc.minutes*60000);

    // Verifica solape final
    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        timeZone: TZ,
        items: [{ id: calId }]
      }
    });
    const busy = (fb.data.calendars?.[calId]?.busy) || [];
    const conflict = busy.some(b => {
      const bStart = new Date(b.start);
      const bEnd   = new Date(b.end);
      return overlaps(start, end, bStart, bEnd);
    });
    if (conflict) return res.status(409).json({ ok:false, message:'Franja ocupada' });

    // Crea evento
    const summary = `Reserva: ${serviceId} – ${name||''}`.trim();
    const description = [
      name ? `Nombre: ${name}` : '',
      phone ? `Tel: ${phone}` : '',
      notes ? `Notas: ${notes}` : ''
    ].filter(Boolean).join('\n');

    await calendar.events.insert({
      calendarId: calId,
      requestBody: {
        summary,
        description,
        start: { dateTime: start.toISOString(), timeZone: TZ },
        end:   { dateTime: end.toISOString(),   timeZone: TZ },
        attendees: email ? [{ email }] : undefined
      }
    });

    res.json({ ok:true });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, message:'Error book' });
  }
}
app.post('/book', bookHandler);
app.post('/', (req,res) => (req.query.fn==='book' ? bookHandler(req,res) : res.status(404).json({ok:false,message:'Not found'}) ));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Backend listening on', PORT));

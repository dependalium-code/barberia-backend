const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CORS (ajusta dominios de tu WP) =====
const ALLOWED_ORIGINS = [
  'https://tudominio.com',
  'https://www.tudominio.com',
  // mientras pruebas, puedes permitir todo, pero solo temporalmente:
  // '*'
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Credentials', 'false');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// ====== Datos de ejemplo en memoria ======
const BOOKINGS = []; // {date:'YYYY-MM-DD', time:'HH:MM', barberId:'ana', serviceId:'corte_caballero'}

// utilidades
const toDate = (dateISO, hhmm) => new Date(`${dateISO}T${hhmm}:00`);
const overlaps = (aStart, aEnd, bStart, bEnd) => (aStart < bEnd && bStart < aEnd);

const SERVICES = {
  corte_caballero: 30, corte_21dias: 30, corte_hasta20: 30, corte_al0: 15,
  corte_barba: 60, corte_barba_21dias: 60, corte_barba_al0: 30,
  barba: 30, cejas: 10, color_barba_barba: 30, color_pelo: 30
};

// ===== Rutas =====

// Healthcheck (Render la usa a veces para verificar que arranca)
app.get('/', (req, res) => res.json({ok:true, service:'barberia-backend'}));

// GET /slots?date=YYYY-MM-DD&barberId=ana&serviceId=corte_caballero
app.get('/slots', (req, res) => {
  const { date, barberId, serviceId } = req.query;
  if (!date || !barberId || !serviceId) {
    return res.status(400).json({ message: 'Faltan parámetros' });
  }
  const minutes = SERVICES[serviceId] || 30;

  // horario fijo 08:00–20:00 cada 15'
  const START_HOUR = 8, END_HOUR = 20, STEP_MINUTES = 15;
  const pad = n => ('0' + n).slice(-2);

  const start = new Date(`${date}T${pad(START_HOUR)}:00`);
  const end   = new Date(`${date}T${pad(END_HOUR)}:00`);

  const busy = BOOKINGS
    .filter(b => b.date === date && b.barberId === barberId)
    .map(b => {
      const s = toDate(b.date, b.time);
      const e = new Date(s.getTime() + (SERVICES[b.serviceId] || 30) * 60000);
      return { s, e };
    });

  const result = [];
  for (let t = new Date(start); t < end; t = new Date(t.getTime() + STEP_MINUTES*60000)) {
    const slotStart = new Date(t);
    const slotEnd   = new Date(slotStart.getTime() + minutes*60000);
    if (slotEnd > end) break;
    const conflict = busy.some(b => overlaps(slotStart, slotEnd, b.s, b.e));
    if (!conflict) result.push(slotStart.toTimeString().slice(0,5));
  }

  res.json({ slots: result });
});

// POST /book {date,time,barberId,serviceId,name,email,phone,notes}
app.post('/book', (req, res) => {
  const { date, time, barberId, serviceId, name } = req.body || {};
  if (!date || !time || !barberId || !serviceId || !name) {
    return res.status(400).json({ ok:false, message:'Datos incompletos' });
  }

  const minutes = SERVICES[serviceId] || 30;
  const start = toDate(date, time);
  const end   = new Date(start.getTime() + minutes*60000);

  const conflict = BOOKINGS.some(b => {
    if (b.date !== date || b.barberId !== barberId) return false;
    const s = toDate(b.date, b.time);
    const e = new Date(s.getTime() + (SERVICES[b.serviceId] || 30) * 60000);
    return overlaps(start, end, s, e);
  });

  if (conflict) return res.status(409).json({ ok:false, message:'Hora no disponible' });

  BOOKINGS.push({ date, time, barberId, serviceId });
  res.json({ ok:true, message:'Reserva creada' });
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});

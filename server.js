// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";

const app = express();

// --- CORS ---
// Para pruebas, abierto. Cuando funcione, cambia a tu dominio de WordPress:
// app.use(cors({ origin: ['https://TU-DOMINIO-WORDPRESS.com','https://www.TU-DOMINIO-WORDPRESS.com'] }));
app.use(cors());
app.options('*', cors());

// --- Body parser ---
app.use(bodyParser.json());

// --- Logs simples para ver las peticiones en Render ---
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// --- Home (sanity check) ---
app.get("/", (_req, res) => {
  res.send("Backend ok ✅");
});

// --- ENDPOINT: /slots (devolver horarios disponibles) ---
// Por ahora son horas de prueba. Luego lo cambiaremos para leer Google Calendar.
app.get("/slots", (req, res) => {
  // opcional: usar query ?date=YYYY-MM-DD&barberId=luis&serviceId=corte_caballero
  // const { date, barberId, serviceId } = req.query;

  // Horarios de ejemplo:
  const slots = ["10:00","10:30","11:00","11:30","12:00","12:30","16:00","16:30","17:00","17:30"];
  res.json({ ok: true, slots });
});

// --- ENDPOINT: /book (crear reserva) ---
// De momento solo devuelve ok=true (mock). Luego lo conectamos a Google Calendar.
app.post("/book", (req, res) => {
  const { date, time, barberId, serviceId, name, email, phone, notes } = req.body || {};
  console.log("Reserva recibida:", { date, time, barberId, serviceId, name, email, phone, notes });
  // Aquí más tarde insertaremos el evento en Google Calendar
  res.json({ ok: true });
});

// --- Arranque ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor escuchando en puerto", PORT);
});

// server.js (CommonJS)
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------- GOOGLE AUTH ----------
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground"
);
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}
const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

// ---------- UTILS ----------
const SERVICE_MINUTES = {
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

function getCalId(barberId) {
  if (barberId === "ana") return process.env.CAL_ANA;
  if (barberId === "luis") return process.env.CAL_LUIS;
  return process.env.CAL_MARCO;
}

// ---------- RUTAS BÁSICAS ----------
app.get("/health", (req, res) => res.send("ok"));

app.get("/env-check", (req, res) => {
  res.json({
    TZ: process.env.TZ || "(no TZ)",
    CAL_ANA: process.env.CAL_ANA ? "ok" : "missing",
    CAL_LUIS: process.env.CAL_LUIS ? "ok" : "missing",
    CAL_MARCO: process.env.CAL_MARCO ? "ok" : "missing",
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? "ok" : "missing",
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? "ok" : "missing",
    GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN ? "ok" : "missing"
  });
});

// ---------- DISPONIBILIDAD ----------
app.get("/slots", async (req, res) => {
  try {
    const { date, barberId, serviceId } = req.query;
    if (!date || !barberId || !serviceId) {
      return res.status(400).json({ ok: false, message: "date, barberId y serviceId son obligatorios" });
    }
    const calId = getCalId(barberId);
    if (!calId) return res.status(400).json({ ok: false, message: "Calendario no configurado" });

    // lee eventos del día
    const startOfDay = new Date(`${date}T00:00:00`);
    const endOfDay = new Date(`${date}T23:59:59`);
    const events = await calendar.events.list({
      calendarId: calId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    // devolvemos las franjas ocupadas (simple)
    const busy = (events.data.items || []).map(ev => ({
      start: ev.start.dateTime,
      end: ev.end.dateTime,
      summary: ev.summary || ""
    }));

    res.json({ ok: true, slots: busy });
  } catch (err) {
    console.error("Error /slots:", err);
    res.status(500).json({ ok: false, message: "Error cargando slots", detail: String(err.message || err) });
  }
});

// ---------- RESERVA ----------
app.post("/book", async (req, res) => {
  try {
    const { date, time, barberId, serviceId, name, email, phone, notes } = req.body || {};
    if (!date || !time || !barberId || !serviceId || !name) {
      return res.status(400).json({ ok: false, message: "Faltan campos obligatorios" });
    }
    const calId = getCalId(barberId);
    if (!calId) return res.status(400).json({ ok: false, message: "Calendario no configurado" });

    const minutes = SERVICE_MINUTES[serviceId] || 30;
    const start = new Date(`${date}T${time}:00`);
    const end = new Date(start.getTime() + minutes * 60000);

    const event = {
      summary: `Reserva: ${name}`,
      description: `Servicio: ${serviceId}\nNotas: ${notes || ""}\nTel: ${phone || ""}\nEmail: ${email || ""}`,
      start: { dateTime: start.toISOString(), timeZone: "Europe/Madrid" },
      end:   { dateTime: end.toISOString(),   timeZone: "Europe/Madrid" },
    };

    await calendar.events.insert({ calendarId: calId, resource: event });
    res.json({ ok: true });
  } catch (err) {
    console.error("Error /book:", err);
    res.status(500).json({ ok: false, message: "No se pudo crear la reserva", detail: String(err.message || err) });
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});

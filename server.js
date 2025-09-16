import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { google } from "googleapis";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ================== GOOGLE AUTH ==================
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground"
);
oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

// ================== RUTAS ==================

// Diagnóstico de variables
app.get("/env-check", (req, res) => {
  res.json({
    CAL_ANA: process.env.CAL_ANA ? "ok" : "missing",
    CAL_LUIS: process.env.CAL_LUIS ? "ok" : "missing",
    CAL_MARCO: process.env.CAL_MARCO ? "ok" : "missing",
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? "ok" : "missing",
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? "ok" : "missing",
    GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN ? "ok" : "missing",
  });
});

// Slots disponibles
app.get("/", async (req, res) => {
  const { fn, date, barberId, serviceId } = req.query;

  if (fn === "slots") {
    try {
      const calId =
        barberId === "ana"
          ? process.env.CAL_ANA
          : barberId === "luis"
          ? process.env.CAL_LUIS
          : process.env.CAL_MARCO;

      const startOfDay = new Date(`${date}T00:00:00`);
      const endOfDay = new Date(`${date}T23:59:59`);

      const events = await calendar.events.list({
        calendarId: calId,
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      const busy = events.data.items.map((ev) => ({
        start: ev.start.dateTime,
        end: ev.end.dateTime,
      }));

      res.json({ slots: busy });
    } catch (err) {
      console.error("Error en slots:", err.message);
      res.status(500).json({ error: "No se pudieron cargar los slots" });
    }
  }

  if (fn === "book") {
    res.status(400).json({ error: "Usa POST para reservar" });
  }
});

// Crear reserva
app.post("/", async (req, res) => {
  const { date, time, barberId, serviceId, name, email, phone, notes } =
    req.body;

  try {
    const calId =
      barberId === "ana"
        ? process.env.CAL_ANA
        : barberId === "luis"
        ? process.env.CAL_LUIS
        : process.env.CAL_MARCO;

    const start = new Date(`${date}T${time}:00`);
    const end = new Date(start.getTime() + 30 * 60000); // 30 min fijo, ajusta según servicio

    const event = {
      summary: `Reserva: ${name}`,
      description: `Servicio: ${serviceId}\nNotas: ${notes}\nTel: ${phone}\nEmail: ${email}`,
      start: { dateTime: start.toISOString(), timeZone: "Europe/Madrid" },
      end: { dateTime: end.toISOString(), timeZone: "Europe/Madrid" },
    };

    await calendar.events.insert({
      calendarId: calId,
      resource: event,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Error al reservar:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ================== INICIO SERVER ==================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
});

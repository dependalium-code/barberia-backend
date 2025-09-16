import express from "express";
import cors from "cors";
import { google } from "googleapis";

const PORT = process.env.PORT || 3000;
const TIMEZONE = "Europe/Madrid";

// IDs de calendario de cada barbero
const CALENDARS = {
  luis: "9c75a9a1d75ccebdc4eac6e4181c57fd1da1cabc30fa413e509749455cba70ec@group.calendar.google.com",
  ana: "9d0890541fd206d30695136ff8e5e4c89563117199c5d4bf3761f955d960fc42@group.calendar.google.com",
  marco: "c439a5eb409549264f234d6b9929bd8cfd8d836570997cd450afdefb55097cfa@group.calendar.google.com"
};

// Credenciales de Google (se configuran como variables de entorno en Render)
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const REDIRECT_URI = "http://localhost";

function getOAuthClient() {
  const oAuth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  return oAuth2Client;
}

const app = express();
app.use(cors());
app.use(express.json());

// Endpoint para reservar
app.post("/", async (req, res) => {
  const { date, time, barberId, serviceId, name } = req.body;
  try {
    const calendarId = CALENDARS[barberId];
    if (!calendarId) return res.status(400).json({ ok: false, message: "Barbero no válido" });

    const [hh, mm] = time.split(":").map(Number);
    const start = new Date(`${date}T${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}:00`);
    const end = new Date(start.getTime() + 30 * 60000); // 30min por defecto

    const auth = getOAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: `${serviceId} – ${name}`,
        start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
        end: { dateTime: end.toISOString(), timeZone: TIMEZONE }
      }
    });

    res.json({ ok: true, message: "Reserva creada en Google Calendar" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Error al crear la reserva" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend escuchando en http://localhost:${PORT}`);
});

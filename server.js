const express = require('express');
const app = express();

// Puerto dinámico de Render
const PORT = process.env.PORT || 10000;

// Middleware para JSON
app.use(express.json());

// ✅ Ruta raíz de prueba
app.get('/', (req, res) => {
  res.send('Backend ok ✅');
});

// ✅ Endpoint de slots de prueba
app.get('/slots', (req, res) => {
  res.json({
    ok: true,
    slots: ["10:00","10:30","11:00","11:30","12:00","12:30","16:00","16:30","17:00","17:30"]
  });
});

// ✅ Endpoint para crear reserva de prueba
app.post('/book', (req, res) => {
  console.log('Nueva reserva:', req.body);
  res.json({ ok: true, message: 'Reserva creada correctamente (mock)' });
});

// Levantar servidor
app.listen(PORT, () => {
  console.log(`Backend escuchando en puerto ${PORT}`);
});

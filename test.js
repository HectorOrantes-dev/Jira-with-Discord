import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import handler from './api/webhook.js';

// 1. Cargar variables de entorno manualmente desde .env
try {
  const envContent = fs.readFileSync('.env', 'utf-8').replace(/^\uFEFF/, ''); // Eliminar BOM si existe
  envContent.split(/\r?\n/).forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) process.env[match[1]] = match[2].trim();
  });
} catch (e) {
  console.warn("Advertencia: No se pudo leer el archivo .env o no existe.");
}

// 2. Crear un servidor HTTP simulando el entorno de Vercel
const server = http.createServer((req, res) => {
  // Simulamos los métodos auxiliares que inyecta Vercel (res.status y res.json)
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res;
  };
  res.json = (data) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  };
  
  // Llamamos a nuestro handler real
  handler(req, res).catch(err => {
    console.error("Error en el handler:", err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
  });
});

// 3. Iniciar el servidor y enviar una petición simulada desde Jira
server.listen(3000, async () => {
  console.log('🌐 Servidor de prueba iniciado en http://localhost:3000');

  // Este es un payload ficticio imitando un evento real de creación de incidencia de Jira
  const payload = {
    webhookEvent: 'jira:issue_created',
    user: { displayName: 'Héctor Román' },
    issue: {
      key: 'TEST-123',
      fields: { summary: 'Esta es una incidencia de prueba generada automáticamente por el script de test.' },
      self: 'https://jira.example.com/api/2/issue/TEST-123'
    }
  };
  
  const rawBody = JSON.stringify(payload);
  const secret = process.env.CLAVESECRETA_WEBHOOK_JIRA;
  
  if (!secret) {
    console.error("❌ CLAVESECRETA_WEBHOOK_JIRA no está definida en .env");
    process.exit(1);
  }

  // Calculamos la firma HMAC-SHA256 como lo haría Jira antes de enviar
  const hash = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const signature = `sha256=${hash}`;

  console.log('\n🚀 Enviando petición POST local simulando ser Jira...');
  try {
    const response = await fetch('http://localhost:3000', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature': signature // Firma vital para pasar la validación de seguridad
      },
      body: rawBody
    });

    const responseData = await response.json();
    console.log(`\n📬 Respuesta del Servidor (Status: ${response.status}):`);
    console.log(responseData);

    if (response.status === 200) {
      console.log('\n✅ ¡Prueba exitosa! Revisa tu canal de Discord, debería haber llegado un mensaje de prueba verde.');
    } else {
      console.log('\n❌ La prueba falló.');
    }
  } catch (error) {
    console.error('Error haciendo la petición HTTP:', error);
  } finally {
    // Cerramos el servidor local de pruebas
    server.close(() => {
      console.log('\n🛑 Servidor de prueba apagado.');
      process.exit(0);
    });
  }
});

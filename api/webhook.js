import crypto from 'crypto';

// Desactivamos el body parser de Vercel para poder leer el cuerpo original
// Esto es necesario para calcular la firma HMAC exactamente como la envió Jira.
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  // Solo permitimos peticiones POST (que es lo que enviará el Webhook de Jira)
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const secret = process.env.CLAVESECRETA_WEBHOOK_JIRA;
  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (!discordWebhookUrl) {
    console.error("DISCORD_WEBHOOK_URL no está configurada.");
    return res.status(500).json({ error: 'Configuración incompleta en el servidor.' });
  }

  // Leemos el cuerpo de la petición de forma cruda (raw buffer/string)
  let rawBody = '';
  for await (const chunk of req) {
    rawBody += chunk;
  }

  // 1. Validación de la Firma (Seguridad)
  if (secret) {
    const signature = req.headers['x-hub-signature'];
    
    if (!signature) {
      console.error("Petición rechazada: Falta cabecera X-Hub-Signature.");
      return res.status(401).json({ error: 'No autorizado. Falta firma de Jira.' });
    }

    // Jira envía la firma en formato `sha256=hash`
    const hash = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const expectedSignature = `sha256=${hash}`;

    if (signature !== expectedSignature) {
      console.error("Firma inválida. Recibida:", signature, "Esperada:", expectedSignature);
      return res.status(401).json({ error: 'Firma HMAC inválida.' });
    }
  }

  // 2. Parseo del Evento
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.error("Error parseando el JSON de Jira:", err);
    return res.status(400).json({ error: 'Cuerpo JSON inválido' });
  }

  const eventType = payload.webhookEvent || 'desconocido';
  const user = payload.user?.displayName || 'Sistema / Usuario Desconocido';
  
  // Valores por defecto para el mensaje de Discord
  let title = `Evento de Jira: ${eventType}`;
  let description = `El usuario **${user}** ha desencadenado este evento.`;
  let color = 3447003; // Azul por defecto
  let embedFields = [];

  // 3. Mapeo de Eventos (Issue, Comentario, Trabajo, etc.)
  if (eventType.startsWith('jira:issue_')) {
    const action = eventType.replace('jira:issue_', '');
    const issueKey = payload.issue?.key || 'Desconocido';
    const summary = payload.issue?.fields?.summary || 'Sin resumen';
    
    // Extracción de nuevos campos
    const assignee = payload.issue?.fields?.assignee?.displayName || 'Sin asignar';
    const dueDate = payload.issue?.fields?.duedate || 'Sin fecha';
    const status = payload.issue?.fields?.status?.name || 'Desconocido';
    
    // Si el evento es creación o actualización, podemos tomar la fecha de actualización del payload como fecha de la actividad.
    const activityDate = payload.issue?.fields?.updated || payload.issue?.fields?.created || new Date().toISOString();
    // Formatear la fecha a algo más legible
    const formattedDate = new Date(activityDate).toLocaleString('es-ES', { 
      dateStyle: 'short', 
      timeStyle: 'short' 
    });

    title = `Incidencia ${action === 'created' ? 'creada' : action === 'updated' ? 'actualizada' : 'eliminada'}: ${issueKey}`;
    description = `**Resumen:** ${summary}`;
    
    embedFields = [
      { name: 'Asignado por / Autor', value: user, inline: true },
      { name: 'Asignado a', value: assignee, inline: true },
      { name: 'Estado', value: status, inline: true },
      { name: 'Fecha de asignación/actividad', value: formattedDate, inline: true },
      { name: 'Fecha de vencimiento', value: dueDate, inline: true }
    ];
    
    if (action === 'created') color = 3066993; // Verde
    else if (action === 'updated') color = 16753920; // Naranja
    else if (action === 'deleted') color = 15158332; // Rojo

  } else if (eventType.startsWith('comment_')) {
    const action = eventType.replace('comment_', '');
    const issueKey = payload.issue?.key || 'Desconocido';
    const commentBody = payload.comment?.body || '';

    title = `Comentario ${action === 'created' ? 'creado' : action === 'updated' ? 'actualizado' : 'eliminado'} en ${issueKey}`;
    description = `**Comentario:** ${commentBody}\n**Usuario:** ${user}`;
    color = 3447003; // Azul

  } else if (eventType.startsWith('worklog_')) {
    const action = eventType.replace('worklog_', '');
    const issueKey = payload.issue?.key || 'Desconocido';
    const timeSpent = payload.worklog?.timeSpent || 'Desconocido';
    
    title = `Registro de trabajo ${action === 'created' ? 'creado' : action === 'updated' ? 'actualizado' : 'eliminado'} en ${issueKey}`;
    description = `**Tiempo registrado:** ${timeSpent}\n**Usuario:** ${user}`;
    color = 9807270; // Gris morado

  } else if (eventType.startsWith('attachment_')) {
    const action = eventType.replace('attachment_', '');
    const filename = payload.attachment?.filename || 'Archivo';
    
    title = `Archivo adjunto ${action === 'created' ? 'creado' : 'eliminado'}`;
    description = `**Archivo:** ${filename}\n**Usuario:** ${user}`;
    color = 10181046; // Púrpura

  } else if (eventType.startsWith('issuelink_')) {
    const action = eventType.replace('issuelink_', '');
    title = `Enlace de incidencia ${action === 'created' ? 'creado' : 'eliminado'}`;
    description = `**Usuario:** ${user}`;
    color = 15844367; // Dorado

  } else if (eventType.startsWith('user_')) {
    const action = eventType.replace('user_', '');
    const targetUser = payload.user?.displayName || 'Usuario';
    title = `Usuario ${action === 'created' ? 'creado' : action === 'updated' ? 'actualizado' : 'eliminado'}`;
    description = `**Usuario afectado:** ${targetUser}`;
    color = 2067276; // Verde azulado
  }

  // 4. Construcción del Payload para Discord (Formato Embed)
  const discordPayload = {
    embeds: [
      {
        title,
        description,
        color,
        fields: embedFields.length > 0 ? embedFields : undefined,
        timestamp: new Date().toISOString()
      }
    ]
  };

  // 5. Envío a Discord
  try {
    const discordResponse = await fetch(discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordPayload)
    });

    if (!discordResponse.ok) {
      const errorText = await discordResponse.text();
      console.error("Error al enviar el mensaje a Discord:", errorText);
      return res.status(502).json({ error: 'Fallo al comunicar con Discord' });
    }

    // Todo ha ido bien
    return res.status(200).json({ success: true, message: 'Evento procesado correctamente' });
  } catch (error) {
    console.error("Error de conexión (Fetch) con Discord:", error);
    return res.status(500).json({ error: 'Error interno de red al contactar con Discord' });
  }
}

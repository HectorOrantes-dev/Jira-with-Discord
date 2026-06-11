import crypto from 'crypto';

// Desactivamos el body parser de Vercel para poder leer el cuerpo original
// Esto es necesario para calcular la firma HMAC exactamente como la envió Jira.
export const config = {
  api: {
    bodyParser: false,
  },
};

async function createGithubBranch(issueType, issueKey, summary) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO; // ej. "Usuario/Proyecto"
  
  if (!token || !repo) {
    console.error("Faltan credenciales de GitHub (GITHUB_TOKEN o GITHUB_REPO)");
    return;
  }

  // Determinar el prefijo de la rama basado en el tipo de tarea de Jira
  const typeLower = issueType.toLowerCase();
  let prefix = 'feature'; // Por defecto
  
  if (typeLower.includes('bug') || typeLower.includes('error')) {
    prefix = 'bugfix';
  } else if (typeLower.includes('task') || typeLower.includes('tarea') || typeLower.includes('subtask')) {
    prefix = 'task';
  } else if (typeLower.includes('historia') || typeLower.includes('story')) {
    prefix = 'story';
  } else if (typeLower.includes('epic') || typeLower.includes('épica')) {
    prefix = 'epic';
  } else if (typeLower.includes('hotfix')) {
    prefix = 'hotfix';
  }

  // Sanitizar el nombre de la rama: minúsculas, espacios por guiones, sin caracteres raros
  const cleanSummary = summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const branchName = `${prefix}/${issueKey}-${cleanSummary}`;

  try {
    // 1. Obtener el SHA de la rama 'qa'
    const qaRefResponse = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/qa`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!qaRefResponse.ok) {
      console.error("Error obteniendo la rama 'qa':", await qaRefResponse.text());
      return;
    }

    const qaRefData = await qaRefResponse.json();
    const qaSha = qaRefData.object.sha;

    // 2. Crear la nueva rama desde el SHA de 'qa'
    const createRefResponse = await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha: qaSha
      })
    });

    if (!createRefResponse.ok) {
      const errorText = await createRefResponse.text();
      // Si el error es Reference already exists (422), ignorarlo silenciosamente
      if (!errorText.includes('Reference already exists')) {
        console.error("Error creando la rama en GitHub:", errorText);
      }
    } else {
      console.log(`Rama ${branchName} creada exitosamente en GitHub.`);
    }
  } catch (err) {
    console.error("Error de red llamando a GitHub:", err);
  }
}

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
    const timeSpent = payload.issue?.fields?.timetracking?.timeSpent || '0h';
    
    // SOLUCIÓN BUG: Ignorar webhooks duplicados (ej. al cambiar de Done a To Do, Jira manda otro solo por 'resolution')
    if (action === 'updated' && payload.changelog && payload.changelog.items) {
      const changedFields = payload.changelog.items.map(item => item.field);
      const isImportantChange = changedFields.some(field => 
        ['status', 'assignee', 'summary', 'description', 'priority'].includes(field)
      );
      if (!isImportantChange) {
        console.log(`Evento ignorado para ${issueKey}. Cambios menores:`, changedFields);
        return res.status(200).json({ success: true, message: 'Evento ignorado (cambio menor/duplicado)' });
      }
    }
    
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
      { name: 'Tiempo invertido', value: timeSpent, inline: true },
      { name: 'Fecha de actividad', value: formattedDate, inline: true },
      { name: 'Fecha de vencimiento', value: dueDate, inline: true }
    ];
    
    // Lógica de colores basada en el ESTADO
    const statusLower = status.toLowerCase();
    if (action === 'deleted') {
      color = 15158332; // Rojo (Eliminada siempre es rojo)
    } else if (statusLower.includes('done') || statusLower.includes('completado') || statusLower.includes('listo')) {
      color = 3447003; // Azul
    } else if (statusLower.includes('review') || statusLower.includes('revisión')) {
      color = 16753920; // Naranja
    } else if (statusLower.includes('progress') || statusLower.includes('progresive') || statusLower.includes('curso')) {
      color = 10181046; // Púrpura
    } else {
      color = 3066993; // Verde (Nuevo / To Do / Por defecto)
    }

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

  // 5. Envío a Discord y GitHub de manera Concurrente
  try {
    const promises = [];
    
    // Tarea 1: Enviar mensaje a Discord
    promises.push(
      fetch(discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discordPayload)
      }).then(async discordResponse => {
        if (!discordResponse.ok) {
          const errorText = await discordResponse.text();
          console.error("Error al enviar el mensaje a Discord:", errorText);
        }
      })
    );

    // Tarea 2: Crear rama en GitHub según el tipo de incidencia
    if (eventType === 'jira:issue_created') {
      const issueType = payload.issue?.fields?.issuetype?.name || 'Task';
      const typeLower = issueType.toLowerCase();
      
      // Si la tarjeta es una Epic, NO creamos rama, ya que actúan solo como agrupadores
      if (!typeLower.includes('epic') && !typeLower.includes('épica')) {
        const issueKey = payload.issue?.key || 'Desconocido';
        const summary = payload.issue?.fields?.summary || 'sin-resumen';
        
        // Creamos la rama dinámicamente con su tipo (Feature, Bug, Task, etc.)
        promises.push(createGithubBranch(issueType, issueKey, summary));
      }
    }

    // Ejecutar ambas promesas al mismo tiempo (Concurrencia)
    await Promise.all(promises);

    // Todo ha ido bien
    return res.status(200).json({ success: true, message: 'Eventos procesados concurrentemente' });
  } catch (error) {
    console.error("Error ejecutando tareas concurrentes:", error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

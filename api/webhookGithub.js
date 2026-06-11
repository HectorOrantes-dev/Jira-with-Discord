import crypto from 'crypto';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const discordWebhookUrl = process.env.DISCORD_GITHUB_WEBHOOK_URL;

  if (!discordWebhookUrl) {
    console.error("DISCORD_GITHUB_WEBHOOK_URL no configurada.");
    return res.status(500).json({ error: 'Configuración incompleta' });
  }

  let rawBody = '';
  for await (const chunk of req) {
    rawBody += chunk;
  }

  // Seguridad: Validar HMAC SHA-256 de GitHub
  if (secret) {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      return res.status(401).json({ error: 'Falta cabecera de firma de GitHub' });
    }

    const hash = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const expectedSignature = `sha256=${hash}`;

    if (signature !== expectedSignature) {
      return res.status(401).json({ error: 'Firma GitHub inválida' });
    }
  }

  const githubEvent = req.headers['x-github-event'];
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'JSON inválido' });
  }

  let title = '';
  let description = '';
  let color = 3447003; // Azul por defecto
  let fields = [];

  // Mapeo de eventos de GitHub a Discord
  if (githubEvent === 'push') {
    const branch = payload.ref.replace('refs/heads/', '');
    const pusher = payload.pusher?.name || 'Alguien';
    const commits = payload.commits || [];
    
    // Ignorar pushes vacíos
    if (commits.length === 0) {
      return res.status(200).json({ message: 'Push sin commits ignorado' });
    }
    
    title = `Push en rama: ${branch}`;
    description = `**${pusher}** hizo un push con ${commits.length} commit(s).`;
    color = 3066993; // Verde

    const commitList = commits.map(c => `- [\`${c.id.substring(0,7)}\`](${c.url}) ${c.message}`).join('\n');
    if (commitList) {
      // Limitamos el tamaño para evitar errores en Discord
      fields.push({ name: 'Commits', value: commitList.substring(0, 1024), inline: false });
    }

  } else if (githubEvent === 'pull_request') {
    const action = payload.action;
    const pr = payload.pull_request;
    const user = pr.user.login;
    const branchHead = pr.head.ref;
    const branchBase = pr.base.ref;
    
    title = `Pull Request ${action}: #${pr.number} ${pr.title}`;
    description = `**Por:** ${user}\n**Ramas:** \`${branchHead}\` -> \`${branchBase}\`\n[Ver Pull Request](${pr.html_url})`;
    
    if (action === 'opened' || action === 'reopened') color = 3066993; // Verde
    else if (action === 'closed' && pr.merged) { 
      color = 10181046; // Púrpura (Merge)
      description += '\n\n✅ **¡MERGE COMPLETADO!**'; 
    }
    else if (action === 'closed') color = 15158332; // Rojo (Cerrado sin merge)
    else color = 15844367; // Amarillo (Updates/Sync)
    
    // Detección de Conflictos (GitHub puede tardar en calcularlo, el primer payload a veces trae null)
    if (action === 'opened' || action === 'synchronize') {
       const mergeable = pr.mergeable_state;
       if (mergeable === 'dirty') {
         fields.push({ name: '⚠️ Conflictos', value: 'Hay conflictos de merge que deben resolverse.', inline: false });
         color = 16753920; // Naranja
       } else if (mergeable === 'clean') {
         fields.push({ name: '✅ Mergeable', value: 'Sin conflictos. Listo para merge.', inline: false });
       }
    }

  } else if (githubEvent === 'ping') {
    title = '🔗 GitHub Webhook Conectado';
    description = 'El webhook ha sido configurado correctamente en el repositorio.';
    color = 3066993;
  } else {
    // Ignorar otros eventos silenciosamente
    return res.status(200).json({ message: 'Evento ignorado' });
  }

  const discordPayload = {
    embeds: [{
      title,
      description,
      color,
      fields: fields.length > 0 ? fields : undefined,
      timestamp: new Date().toISOString()
    }]
  };

  try {
    const discordResponse = await fetch(discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordPayload)
    });
    
    if (!discordResponse.ok) {
      console.error("Error enviando a Discord:", await discordResponse.text());
      return res.status(502).json({ error: 'Error comunicando con Discord' });
    }
  } catch (err) {
    console.error("Error de conexión con Discord", err);
    return res.status(500).json({ error: 'Fallo interno de red' });
  }

  return res.status(200).json({ success: true });
}

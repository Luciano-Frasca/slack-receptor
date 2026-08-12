// api/slack.js
// Receptor de las interacciones de Slack (botones + modal).
// Corre en Vercel. Escribe en el Google Sheet vía Service Account.

import { google } from 'googleapis';

/******************** CONFIG (desde variables de entorno) ********************/
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const REQUEST_KEY = process.env.SLACK_REQUEST_KEY;
const SHEET_ID = process.env.SHEET_ID;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'soporte.it@visma.com';
const IT_SLACK_CHANNEL = process.env.IT_SLACK_CHANNEL || '';
const MAIL_WEBHOOK_URL = process.env.MAIL_WEBHOOK_URL;

const LOG_TAB = 'Log';

// Columnas del Log (0-based)
// A: SolicitudID, B: AccesoID, C: Fecha, D: Ingreso, E: Manager,
// F: Recurso, G: Nivel, H: Owner, I: Estado, J: Empresa, K: Comentario, L: FechaResp
const COL = {
  SOLICITUD: 0, ACCESO: 1, FECHA: 2, INGRESO: 3, MANAGER: 4,
  RECURSO: 5, NIVEL: 6, OWNER: 7, ESTADO: 8, EMPRESA: 9, COMENTARIO: 10, FECHARESP: 11,
};

// Mapa Empresa -> alias de remitente
const ALIAS_MAP = {
  'Calipso':   'admin.it@calipso.com',
  'Contagram': 'admin.it@contagram.com',
  'Xubio':     'admin.it@xubio.com',
  'Visma':     'admin.it@visma.com',
  'LaraAI':    'admin.it@visma.com',
};

/******************** GOOGLE SHEETS (Service Account) ********************/
function getCredentials() {
  return JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
}

// Cacheado a nivel de módulo: en invocaciones "warm" de Vercel se reutiliza
// la misma instancia y evitamos volver a autenticar contra Google cada vez.
let cachedSheetsClient = null;

async function getSheets() {
  if (cachedSheetsClient) return cachedSheetsClient;
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  cachedSheetsClient = google.sheets({ version: 'v4', auth: client });
  return cachedSheetsClient;
}

async function readLog() {
  const sheets = await getSheets();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${LOG_TAB}!A:L`,
  });
  return resp.data.values || [];
}

async function updateLogRow(rowIndex1Based, estado, comentario) {
  const sheets = await getSheets();
  const fecha = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  // Escribe Estado (I), salta Empresa (J, la pone Apps Script), Comentario (K), FechaResp (L)
  const resp = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${LOG_TAB}!I${rowIndex1Based}`, values: [[estado]] },
        { range: `${LOG_TAB}!K${rowIndex1Based}`, values: [[comentario || '']] },
        { range: `${LOG_TAB}!L${rowIndex1Based}`, values: [[fecha]] },
      ],
    },
  });
  console.log('updateLogRow: fila=', rowIndex1Based, 'estado=', estado, 'responses=', JSON.stringify(resp.data.responses));
}

/******************** SLACK API ********************/
async function slackApi(method, body) {
  const resp = await fetch('https://slack.com/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + SLACK_BOT_TOKEN },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function postToResponseUrl(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  console.log('postToResponseUrl: status=', resp.status, 'body=', text);
}

/******************** LÓGICA ********************/
function openCommentModal(triggerId, meta) {
  const required = meta.action === 'other';
  const titulos = { approve: 'Aprobar acceso', reject: 'Rechazar acceso', other: 'Otra respuesta' };
  const view = {
    type: 'modal',
    callback_id: 'comment_modal',
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: titulos[meta.action] || 'Respuesta' },
    submit: { type: 'plain_text', text: 'Confirmar' },
    close: { type: 'plain_text', text: 'Cancelar' },
    blocks: [{
      type: 'input', optional: !required, block_id: 'c',
      element: { type: 'plain_text_input', multiline: true, action_id: 'txt' },
      label: { type: 'plain_text', text: required ? 'Detalle / motivo' : 'Comentario (opcional)' },
    }],
  };
  return slackApi('views.open', { trigger_id: triggerId, view });
}

async function finalizeAccess(data, accesoId, action, comment) {
  console.log('finalizeAccess: buscando accesoId=', JSON.stringify(accesoId), 'entre', data.length - 1, 'filas');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][COL.ACCESO]) === accesoId) {
      console.log('finalizeAccess: match en fila', i + 1);
      const estado = action === 'approve' ? 'APROBADO' : action === 'reject' ? 'RECHAZADO' : 'OTRO';
      await updateLogRow(i + 1, estado, comment);
      // Reflejamos el update en la copia en memoria para que los cálculos
      // que siguen (pendientes/respondidas) no necesiten releer el sheet.
      data[i][COL.ESTADO] = estado;
      data[i][COL.COMENTARIO] = comment || '';
      return {
        solicitudId: String(data[i][COL.SOLICITUD]),
        ingreso: String(data[i][COL.INGRESO]),
        manager: String(data[i][COL.MANAGER]),
        recurso: String(data[i][COL.RECURSO]),
        nivel: String(data[i][COL.NIVEL] || ''),
        owner: String(data[i][COL.OWNER]),
        empresa: String(data[i][COL.EMPRESA] || ''),
        estado,
        comentario: comment || '',
      };
    }
  }
  console.log('finalizeAccess: NO se encontro ninguna fila con AccesoID=', JSON.stringify(accesoId), '- valores presentes:', data.slice(1).map(r => r[COL.ACCESO]));
  return null;
}

function ownerRemainingPending(data, solicitudId, owner) {
  let n = 0;
  for (let i = 1; i < data.length; i++) {
    if (
      String(data[i][COL.SOLICITUD]).trim() === solicitudId.trim() &&
      String(data[i][COL.OWNER]).trim().toLowerCase() === owner.trim().toLowerCase() &&
      String(data[i][COL.ESTADO]).trim() === 'PENDIENTE'
    ) n++;
  }
  return n;
}

function ownerAnsweredRows(data, solicitudId, owner) {
  const finales = ['APROBADO', 'RECHAZADO', 'OTRO'];
  return data.filter((r, idx) =>
    idx > 0 &&
    String(r[COL.SOLICITUD]).trim() === solicitudId.trim() &&
    String(r[COL.OWNER]).trim().toLowerCase() === owner.trim().toLowerCase() &&
    finales.includes(String(r[COL.ESTADO]).trim())
  );
}

async function updateMessage(responseUrl, res, responder) {
  const icono = res.estado === 'APROBADO' ? '✅ Aprobado' : res.estado === 'RECHAZADO' ? '❌ Rechazado' : '✏️ Otro';
  const txt = `*Solicitud de acceso — ${icono}*\nEmpresa: *${res.empresa}*\nIngreso: *${res.ingreso}*\nRecurso: *${res.recurso}*${res.nivel ? ` (nivel: ${res.nivel})` : ''}\nRespondido por: ${responder}${res.comentario ? `\nComentario: ${res.comentario}` : ''}`;
  await postToResponseUrl(responseUrl, {
    replace_original: true,
    text: txt,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: txt } }],
  });
}

async function sendMail(ownerEmail, ingreso, manager, empresa, rows) {
  const fromAlias = ALIAS_MAP[empresa] || ALIAS_MAP['Visma'];
   console.log('empresa recibida:', empresa, '| alias elegido:', fromAlias);
  const body =
    `Onboarding: ${ingreso}\nManager: ${manager}\nEmpresa: ${empresa}\nOwner que respondió: ${ownerEmail}\n\nRespuestas:\n` +
    rows.map(r =>
      `• ${r[COL.RECURSO]}${r[COL.NIVEL] ? ` (${r[COL.NIVEL]})` : ''}: ${r[COL.ESTADO]}${r[COL.COMENTARIO] ? ` — ${r[COL.COMENTARIO]}` : ''}`
    ).join('\n') +
    '\n\n(Enviado automáticamente por Aprobaciones IT)';

  if (!MAIL_WEBHOOK_URL) {
    console.error('sendMail: MAIL_WEBHOOK_URL no esta configurada, no se puede enviar el mail');
    return;
  }
  const resp = await fetch(MAIL_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: REQUEST_KEY,
      to: SUPPORT_EMAIL,
      from: fromAlias,
      subject: `[${empresa}] Accesos ${ingreso} — respuestas de ${ownerEmail}`,
      body,
    }),
  });
  const text = await resp.text();
  console.log('sendMail: status=', resp.status, 'body=', text);
  if (!resp.ok) {
    console.error('sendMail: el webhook de Apps Script respondio con error, status=', resp.status);
  }
}

async function notifyIT(ownerEmail, ingreso, empresa, rows) {
  if (!IT_SLACK_CHANNEL) return;
  const txt = `*[${empresa}] Respuestas recibidas* para *${ingreso}* de ${ownerEmail}:\n` +
    rows.map(r => `• ${r[COL.RECURSO]}: ${r[COL.ESTADO]}${r[COL.COMENTARIO] ? ` (${r[COL.COMENTARIO]})` : ''}`).join('\n');
  await slackApi('chat.postMessage', { channel: IT_SLACK_CHANNEL, text: txt });
}

/******************** HANDLER PRINCIPAL ********************/

export const config = {maxDuration: 30,};

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') { res.status(200).send('ok'); return; }

    const url = new URL(req.url, 'http://x');
    const key = url.searchParams.get('key');
    if (key !== REQUEST_KEY) { res.status(200).send(''); return; }

    const payload = JSON.parse(req.body.payload);
    
    if (payload.type === 'block_actions') {
      const action = payload.actions[0];
      const meta = {
        accesoId: action.value,
        action: action.action_id,
        response_url: payload.response_url,
        responderName: (payload.user && (payload.user.username || payload.user.name)) || 'owner',
      };
      await openCommentModal(payload.trigger_id, meta);
      res.status(200).send('');
      return;
    }

    if (payload.type === 'view_submission') {
      const meta = JSON.parse(payload.view.private_metadata);
      let comment = '';
      try { comment = payload.view.state.values['c']['txt'].value || ''; } catch (e) {}

      // Respondemos a Slack YA para cerrar el modal sin error.
      res.status(200).json({ response_action: 'clear' });

      // El trabajo pesado corre en background: Vercel espera que termine
      // aunque ya respondimos (waitUntil garantiza que no se corta).
      const workPromise = (async () => {
        try {
          console.log('workPromise: start meta=', JSON.stringify(meta));
          const data = await readLog();
          console.log('workPromise: readLog ok, filas=', data.length);
          const result = await finalizeAccess(data, meta.accesoId, meta.action, comment);
          console.log('workPromise: finalizeAccess result=', JSON.stringify(result));
          if (result && meta.response_url) {
            await updateMessage(meta.response_url, result, meta.responderName);
            console.log('workPromise: updateMessage OK');
          }
          if (result && ownerRemainingPending(data, result.solicitudId, result.owner) === 0) {
            const rows = ownerAnsweredRows(data, result.solicitudId, result.owner);
            await sendMail(result.owner, result.ingreso, result.manager, result.empresa, rows);
            await notifyIT(result.owner, result.ingreso, result.empresa, rows);
            console.log('workPromise: mail + notifyIT OK');
          }
        } catch (e) {
          console.error('workPromise ERROR:', e && e.stack ? e.stack : e);
        }
      })();

      // waitUntil le dice a Vercel que espere esta promesa aunque ya respondimos.
      if (res.waitUntil) {
        res.waitUntil(workPromise);
      } else {
        await workPromise; // fallback por si el entorno no soporta waitUntil
      }
      return;
    }

    res.status(200).send('');
  } catch (err) {
    console.error('ERROR:', err);
    if (!res.headersSent) res.status(200).json({ response_action: 'clear' });
  }
}

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
// Columnas del Log (0-based): SolicitudID, AccesoID, Fecha, Ingreso, Manager, Recurso, Nivel, Owner, Estado, Comentario, FechaResp
const COL = { SOLICITUD: 0, ACCESO: 1, FECHA: 2, INGRESO: 3, MANAGER: 4, RECURSO: 5, NIVEL: 6, OWNER: 7, ESTADO: 8, COMENTARIO: 9, FECHARESP: 10 };

/******************** GOOGLE SHEETS (Service Account) ********************/
function getCredentials() {
  return JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
}

async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

async function readLog() {
  const sheets = await getSheets();
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${LOG_TAB}!A:K` });
  return resp.data.values || [];
}

async function updateLogRow(rowIndex1Based, estado, comentario) {
  const sheets = await getSheets();
  const fecha = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${LOG_TAB}!I${rowIndex1Based}:K${rowIndex1Based}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[estado, comentario || '', fecha]] },
  });
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
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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

async function finalizeAccess(accesoId, action, comment) {
  const data = await readLog();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][COL.ACCESO]) === accesoId) {
      const estado = action === 'approve' ? 'APROBADO' : action === 'reject' ? 'RECHAZADO' : 'OTRO';
      await updateLogRow(i + 1, estado, comment);
      return {
        solicitudId: data[i][COL.SOLICITUD], ingreso: data[i][COL.INGRESO], manager: data[i][COL.MANAGER],
        recurso: data[i][COL.RECURSO], nivel: data[i][COL.NIVEL], owner: data[i][COL.OWNER],
        estado, comentario: comment || '',
      };
    }
  }
  return null;
}

async function ownerRemainingPending(solicitudId, owner) {
  const data = await readLog();
  let n = 0;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][COL.SOLICITUD]) === solicitudId && String(data[i][COL.OWNER]) === owner && String(data[i][COL.ESTADO]) === 'PENDIENTE') n++;
  }
  return n;
}

async function ownerAnsweredRows(solicitudId, owner) {
  const data = await readLog();
  const finales = ['APROBADO', 'RECHAZADO', 'OTRO'];
  return data.filter((r, idx) => idx > 0 && String(r[COL.SOLICITUD]) === solicitudId && String(r[COL.OWNER]) === owner && finales.includes(String(r[COL.ESTADO])));
}

async function updateMessage(responseUrl, res, responder) {
  const icono = res.estado === 'APROBADO' ? '✅ Aprobado' : res.estado === 'RECHAZADO' ? '❌ Rechazado' : '✏️ Otro';
  const txt = `*Solicitud de acceso — ${icono}*\nIngreso: *${res.ingreso}*\nRecurso: *${res.recurso}*${res.nivel ? ` (nivel: ${res.nivel})` : ''}\nRespondido por: ${responder}${res.comentario ? `\nComentario: ${res.comentario}` : ''}`;
  await postToResponseUrl(responseUrl, { replace_original: true, text: txt, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: txt } }] });
}

async function sendMail(ownerEmail, ingreso, manager, rows) {
  const body = `Onboarding: ${ingreso}\nManager: ${manager}\nOwner que respondió: ${ownerEmail}\n\nRespuestas:\n` +
    rows.map(r => `• ${r[COL.RECURSO]}${r[COL.NIVEL] ? ` (${r[COL.NIVEL]})` : ''}: ${r[COL.ESTADO]}${r[COL.COMENTARIO] ? ` — ${r[COL.COMENTARIO]}` : ''}`).join('\n');
  await fetch(MAIL_WEBHOOK_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: REQUEST_KEY, to: SUPPORT_EMAIL, subject: `Accesos ${ingreso} — respuestas de ${ownerEmail}`, body }),
  });
}

async function notifyIT(ownerEmail, ingreso, rows) {
  if (!IT_SLACK_CHANNEL) return;
  const txt = `*Respuestas recibidas* para *${ingreso}* de ${ownerEmail}:\n` +
    rows.map(r => `• ${r[COL.RECURSO]}: ${r[COL.ESTADO]}${r[COL.COMENTARIO] ? ` (${r[COL.COMENTARIO]})` : ''}`).join('\n');
  await slackApi('chat.postMessage', { channel: IT_SLACK_CHANNEL, text: txt });
}

/******************** HANDLER PRINCIPAL ********************/
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') { res.status(200).send('ok'); return; }

    const url = new URL(req.url, 'http://x');
    const key = url.searchParams.get('key');
    if (key !== REQUEST_KEY) { res.status(200).send(''); return; }

    // El body llega urlencoded con un campo "payload". Vercel lo parsea en req.body.
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

      // Respondemos YA a Slack para cerrar el modal.
      res.status(200).json({ response_action: 'clear' });

      // Seguimos el trabajo después de responder.
      const result = await finalizeAccess(meta.accesoId, meta.action, comment);
      if (result && meta.response_url) await updateMessage(meta.response_url, result, meta.responderName);
      if (result && (await ownerRemainingPending(result.solicitudId, result.owner)) === 0) {
        const rows = await ownerAnsweredRows(result.solicitudId, result.owner);
        await sendMail(result.owner, result.ingreso, result.manager, rows);
        await notifyIT(result.owner, result.ingreso, rows);
      }
      return;
    }

    res.status(200).send('');
  } catch (err) {
    console.error('ERROR:', err);
    if (!res.headersSent) res.status(200).json({ response_action: 'clear' });
  }
}
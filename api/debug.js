// api/debug.js — TEMPORAL
export default function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const key = url.searchParams.get('key');
    if (key !== process.env.SLACK_REQUEST_KEY) {
      return res.status(200).json({ error: 'key no coincide', keyRecibida: key || '(vacia)' });
    }
    const p = (v) => v ? (String(v).slice(0, 12) + '...(' + String(v).length + ' chars)') : '(VACIA)';
    return res.status(200).json({
      SLACK_BOT_TOKEN: p(process.env.SLACK_BOT_TOKEN),
      SLACK_REQUEST_KEY: p(process.env.SLACK_REQUEST_KEY),
      SHEET_ID: p(process.env.SHEET_ID),
      SUPPORT_EMAIL: process.env.SUPPORT_EMAIL || '(VACIA)',
      MAIL_WEBHOOK_URL: p(process.env.MAIL_WEBHOOK_URL),
      GOOGLE_CREDENTIALS_empieza: p(process.env.GOOGLE_CREDENTIALS),
    });
  } catch (e) {
    return res.status(200).json({ crash: String(e) });
  }
}
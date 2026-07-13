# slack-receptor

Receptor de Slack para Aprobaciones IT (Vercel)

Recibe las interacciones de Slack (botones + modal) y escribe en el Google Sheet
vía Service Account. Reemplaza al doPost de Apps Script, que no puede responder
a los modales de Slack por una limitación de la plataforma.

Endpoint

POST /api/slack?key=TU_CLAVE

Esa es la URL que va en Slack → Interactivity & Shortcuts → Request URL.

Variables de entorno (se cargan en Vercel, NO en el código)

VariableQué esSLACK_BOT_TOKENEl token xoxb-... de la Slack AppSLACK_REQUEST_KEYLa clave secreta que va en ?key= de la URLSHEET_IDID del Sheet de RESPUESTAS (donde está la pestaña "Log")GOOGLE_CREDENTIALSEl JSON completo de la Service Account (pegado como una línea)SUPPORT_EMAILsoporte.it@visma.comIT_SLACK_CHANNEL(opcional) ID del canal de IT para avisosMAIL_WEBHOOK_URLURL del Web App de Apps Script que manda el mail (ver nota)

Nota sobre el mail

El envío del mail a soporte.it lo sigue haciendo Apps Script (MailApp), porque
mandar mail desde una Service Account requiere configuración extra de Google Workspace.
Vercel le pega a un pequeño Web App de Apps Script que solo manda el mail.
El código de ese Web App se agrega en el proyecto de Apps Script (ver chat).
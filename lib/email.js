const config = require('./config');
const logger = require('./logger');

async function resendFetch(payload) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 5000);
  try {
    return await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${config.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

const PLAN_LABELS = {
  pro:       'Pro (249 zł / mies.)',
  vip:       'VIP (699 zł / mies.)',
  mentoring: 'Mentoring 1:1 (800 zł / sesja)',
};

function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function buildConfirmationHtml(name, plan) {
  const label    = escHtml(PLAN_LABELS[plan] || plan);
  const safeName = name ? escHtml(name) : null;
  const greeting = safeName ? `Cześć ${safeName},` : 'Cześć,';
  return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zapisano na waitlistę</title>
</head>
<body style="margin:0;padding:0;background:#080810;font-family:'DM Sans',Arial,sans-serif;color:#f0ede8;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#080810;padding:40px 20px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#0d0d1a;border:1px solid rgba(201,168,76,0.2);border-radius:6px;overflow:hidden;max-width:560px;width:100%;">

      <!-- HEADER -->
      <tr>
        <td style="padding:32px 36px 24px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <span style="font-family:Georgia,serif;font-size:20px;font-weight:500;color:#f0ede8;letter-spacing:0.02em;">
            Funded <span style="color:#c9a84c;">by Walesz</span>
          </span>
        </td>
      </tr>

      <!-- BODY -->
      <tr>
        <td style="padding:36px 36px 28px;">
          <p style="margin:0 0 16px;font-size:15px;color:#8a8799;line-height:1.6;">${greeting}</p>
          <p style="margin:0 0 24px;font-size:15px;color:#f0ede8;line-height:1.6;">
            Jesteś na <strong style="color:#c9a84c;">liście oczekujących</strong> na program <em>Funded by Walesz</em>.
          </p>

          <!-- PLAN BOX -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#111120;border:1px solid rgba(201,168,76,0.15);border-radius:4px;margin-bottom:24px;">
            <tr>
              <td style="padding:16px 20px;">
                <span style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:#c9a84c;font-family:monospace;">Wybrany plan</span><br>
                <span style="font-size:16px;font-weight:500;color:#f0ede8;">${label}</span>
              </td>
            </tr>
          </table>

          <p style="margin:0 0 16px;font-size:14px;color:#8a8799;line-height:1.7;">
            Kiedy otworzymy program lub pojawi się wolne miejsce — dostaniesz ode mnie wiadomość jako jeden z pierwszych.
          </p>
          <p style="margin:0;font-size:14px;color:#8a8799;line-height:1.7;">
            Do zobaczenia,<br>
            <strong style="color:#f0ede8;">Walesz</strong>
          </p>
        </td>
      </tr>

      <!-- FOOTER -->
      <tr>
        <td style="padding:20px 36px;border-top:1px solid rgba(255,255,255,0.06);">
          <p style="margin:0;font-size:11px;color:#4a4860;font-family:monospace;letter-spacing:0.05em;">
            © 2025 Funded by Walesz · Wypisz się odpowiadając na ten email.
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

async function sendWaitlistConfirmation(email, plan, name) {
  if (!config.RESEND_API_KEY) return;

  const label = PLAN_LABELS[plan] || plan;
  const subject = `Jesteś na liście — Funded by Walesz [${label}]`;

  try {
    const res = await resendFetch({
      from:    config.RESEND_FROM,
      to:      [email],
      subject,
      html:    buildConfirmationHtml(name, plan),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body }, '[email] resend error');
    } else {
      logger.info({ email, plan }, '[email] confirmation sent');
    }
  } catch (err) {
    logger.warn({ err: err?.name === 'AbortError' ? 'timeout' : err }, '[email] send failed (non-fatal)');
  }
}

function buildWelcomeHtml(name, plan, code) {
  const label    = escHtml(PLAN_LABELS[plan] || plan);
  const safeName = name ? escHtml(name) : null;
  const greeting = safeName ? `Cześć ${safeName},` : 'Cześć,';
  const safeCode = escHtml(code);
  return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Twój dostęp — Funded by Walesz</title>
</head>
<body style="margin:0;padding:0;background:#080810;font-family:'DM Sans',Arial,sans-serif;color:#f0ede8;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#080810;padding:40px 20px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#0d0d1a;border:1px solid rgba(201,168,76,0.2);border-radius:6px;overflow:hidden;max-width:560px;width:100%;">

      <!-- HEADER -->
      <tr>
        <td style="padding:32px 36px 24px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <span style="font-family:Georgia,serif;font-size:20px;font-weight:500;color:#f0ede8;letter-spacing:0.02em;">
            Funded <span style="color:#c9a84c;">by Walesz</span>
          </span>
        </td>
      </tr>

      <!-- BODY -->
      <tr>
        <td style="padding:36px 36px 28px;">
          <p style="margin:0 0 16px;font-size:15px;color:#8a8799;line-height:1.6;">${greeting}</p>
          <p style="margin:0 0 24px;font-size:15px;color:#f0ede8;line-height:1.6;">
            Twój dostęp do <strong style="color:#c9a84c;">Funded by Walesz</strong> jest gotowy. Poniżej znajdziesz swój kod dostępu.
          </p>

          <!-- PLAN BOX -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#111120;border:1px solid rgba(201,168,76,0.15);border-radius:4px;margin-bottom:16px;">
            <tr>
              <td style="padding:14px 20px;">
                <span style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:#c9a84c;font-family:monospace;">Plan</span><br>
                <span style="font-size:16px;font-weight:500;color:#f0ede8;">${label}</span>
              </td>
            </tr>
          </table>

          <!-- CODE BOX -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#111120;border:1px solid rgba(201,168,76,0.3);border-radius:4px;margin-bottom:24px;">
            <tr>
              <td style="padding:16px 20px;">
                <span style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:#c9a84c;font-family:monospace;">Kod dostępu</span><br>
                <span style="font-size:22px;font-weight:700;color:#f0ede8;font-family:monospace;letter-spacing:0.1em;">${safeCode}</span>
              </td>
            </tr>
          </table>

          <p style="margin:0 0 16px;font-size:14px;color:#8a8799;line-height:1.7;">
            Zaloguj się na stronie subskrybenta podając swój email i powyższy kod. Zachowaj go w bezpiecznym miejscu.
          </p>
          <p style="margin:0;font-size:14px;color:#8a8799;line-height:1.7;">
            Do zobaczenia,<br>
            <strong style="color:#f0ede8;">Walesz</strong>
          </p>
        </td>
      </tr>

      <!-- FOOTER -->
      <tr>
        <td style="padding:20px 36px;border-top:1px solid rgba(255,255,255,0.06);">
          <p style="margin:0;font-size:11px;color:#4a4860;font-family:monospace;letter-spacing:0.05em;">
            © 2025 Funded by Walesz · Jeśli to nie Ty, zignoruj tę wiadomość.
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

async function sendSubscriberWelcome(email, name, plan, code) {
  if (!config.RESEND_API_KEY) return;

  const label   = PLAN_LABELS[plan] || plan;
  const subject = `Twój dostęp do Funded by Walesz — ${label}`;

  try {
    const res = await resendFetch({
      from:    config.RESEND_FROM,
      to:      [email],
      subject,
      html:    buildWelcomeHtml(name, plan, code),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body }, '[email] resend error (welcome)');
    } else {
      logger.info({ email, plan }, '[email] welcome sent');
    }
  } catch (err) {
    logger.warn({ err: err?.name === 'AbortError' ? 'timeout' : err }, '[email] welcome send failed (non-fatal)');
  }
}

function buildReplyNotificationHtml(name, subject, content) {
  const safeName    = name ? escHtml(name) : null;
  const greeting    = safeName ? `Cześć ${safeName},` : 'Cześć,';
  const safeSubject = escHtml(subject || 'Twoja wiadomość');
  const safeContent = escHtml(content.slice(0, 300)) + (content.length > 300 ? '…' : '');
  return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nowa odpowiedź — Funded by Walesz</title>
</head>
<body style="margin:0;padding:0;background:#080810;font-family:'DM Sans',Arial,sans-serif;color:#f0ede8;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#080810;padding:40px 20px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#0d0d1a;border:1px solid rgba(201,168,76,0.2);border-radius:6px;overflow:hidden;max-width:560px;width:100%;">

      <!-- HEADER -->
      <tr>
        <td style="padding:32px 36px 24px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <span style="font-family:Georgia,serif;font-size:20px;font-weight:500;color:#f0ede8;letter-spacing:0.02em;">
            Funded <span style="color:#c9a84c;">by Walesz</span>
          </span>
        </td>
      </tr>

      <!-- BODY -->
      <tr>
        <td style="padding:36px 36px 28px;">
          <p style="margin:0 0 16px;font-size:15px;color:#8a8799;line-height:1.6;">${greeting}</p>
          <p style="margin:0 0 24px;font-size:15px;color:#f0ede8;line-height:1.6;">
            Masz nową odpowiedź w temacie: <strong style="color:#c9a84c;">${safeSubject}</strong>
          </p>

          <!-- MESSAGE BOX -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#111120;border:1px solid rgba(255,255,255,0.08);border-radius:4px;margin-bottom:24px;">
            <tr>
              <td style="padding:16px 20px;">
                <span style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:#8a8799;font-family:monospace;">Treść odpowiedzi</span><br><br>
                <span style="font-size:14px;color:#f0ede8;line-height:1.7;">${safeContent}</span>
              </td>
            </tr>
          </table>

          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
            <tr>
              <td align="center">
                <a href="https://waleszdesk.com/subscriber" style="display:inline-block;padding:12px 28px;background:#c9a84c;color:#080810;font-weight:600;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;text-decoration:none;border-radius:4px;">Przejdź do panelu</a>
              </td>
            </tr>
          </table>

          <p style="margin:0;font-size:14px;color:#8a8799;line-height:1.7;">
            Do zobaczenia,<br>
            <strong style="color:#f0ede8;">Walesz</strong>
          </p>
        </td>
      </tr>

      <!-- FOOTER -->
      <tr>
        <td style="padding:20px 36px;border-top:1px solid rgba(255,255,255,0.06);">
          <p style="margin:0;font-size:11px;color:#4a4860;font-family:monospace;letter-spacing:0.05em;">
            © 2025 Funded by Walesz · Zaloguj się na waleszdesk.com/subscriber
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

async function sendSubscriberReplyEmail(email, name, subject, content) {
  if (!config.RESEND_API_KEY) return;
  try {
    const res = await resendFetch({
      from:    config.RESEND_FROM,
      to:      [email],
      subject: `Nowa odpowiedź — ${subject || 'Funded by Walesz'}`,
      html:    buildReplyNotificationHtml(name, subject, content),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body }, '[email] resend error (reply)');
    } else {
      logger.info({ email }, '[email] reply notification sent');
    }
  } catch (err) {
    logger.warn({ err: err?.name === 'AbortError' ? 'timeout' : err }, '[email] reply send failed (non-fatal)');
  }
}

module.exports = { sendWaitlistConfirmation, sendSubscriberWelcome, sendSubscriberReplyEmail };

/* WaleszDesk UI helpers — toast, confirm, error mapping. Shared across pages. */
(function (global) {
  'use strict';

  // ── Error code → Polish message ──────────────────────────────────────────────
  const ERR_PL = {
    INVALID_PASSWORD:     'Nieprawidłowe hasło.',
    TOTP_REQUIRED:        'Wymagany kod 2FA.',
    INVALID_TOTP:         'Nieprawidłowy kod 2FA.',
    UNAUTHORIZED:         'Brak autoryzacji. Zaloguj się ponownie.',
    FORBIDDEN:            'Brak uprawnień.',
    VALIDATION_FAILED:    'Nieprawidłowe dane wejściowe.',
    MISSING_FIELD:        'Wymagane pole jest puste.',
    NOT_FOUND:            'Nie znaleziono zasobu.',
    ALREADY_EXISTS:       'Zasób już istnieje.',
    CONFLICT:             'Konflikt — zasób już zmieniony.',
    INSUFFICIENT_BALANCE: 'Niewystarczające saldo.',
    INVALID_KEYS:         'Nieprawidłowe klucze API.',
    EXCHANGE_REJECTED:    'Giełda odrzuciła żądanie.',
    EXCHANGE_TIMEOUT:     'Giełda nie odpowiada — spróbuj ponownie.',
    MIN_CAPITAL:          'Kapitał poniżej minimum dla tej strategii.',
    MAX_CAPITAL:          'Kapitał przekracza 50% salda.',
    UID_REGISTERED:       'To konto giełdowe jest już zarejestrowane.',
    INVALID_INVITE:       'Nieprawidłowy lub już użyty kod zaproszenia.',
    RATE_LIMITED:         'Zbyt wiele żądań — odczekaj chwilę.',
    INTERNAL:             'Wystąpił błąd serwera.',
  };

  function wdErrorMessage(payload, fallback) {
    if (!payload) return fallback || 'Wystąpił błąd.';
    if (typeof payload === 'string') return ERR_PL[payload] || payload;
    const code = payload.errorCode;
    if (code && ERR_PL[code]) return ERR_PL[code];
    return payload.error || payload.message || fallback || 'Wystąpił błąd.';
  }

  // ── Toast ────────────────────────────────────────────────────────────────────
  function ensureToastContainer() {
    let c = document.getElementById('wd-toast-container');
    if (c) return c;
    c = document.createElement('div');
    c.id = 'wd-toast-container';
    c.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;display:flex;flex-direction:column;gap:10px;pointer-events:none;max-width:380px;';
    document.body.appendChild(c);
    return c;
  }

  function wdToast(type, msg, duration) {
    if (!document.body) { document.addEventListener('DOMContentLoaded', () => wdToast(type, msg, duration)); return; }
    const c    = ensureToastContainer();
    const el   = document.createElement('div');
    const dur  = typeof duration === 'number' ? duration : 4000;
    const palette = {
      success: { bg: '#0e2820', border: '#1ea66a', icon: '✓' },
      error:   { bg: '#2a0e12', border: '#e35567', icon: '✕' },
      warning: { bg: '#2a2007', border: '#c9a84c', icon: '⚠' },
      info:    { bg: '#0f1a2a', border: '#5b87ff', icon: 'ℹ' },
    };
    const p = palette[type] || palette.info;
    el.style.cssText = `pointer-events:auto;background:${p.bg};border:1px solid ${p.border};border-left:4px solid ${p.border};color:#f0ede8;padding:12px 16px;border-radius:6px;font:14px/1.4 'DM Sans',system-ui,Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4);display:flex;gap:10px;align-items:flex-start;transform:translateX(120%);transition:transform .25s ease,opacity .25s ease;opacity:0;`;
    el.innerHTML = `<span style="color:${p.border};font-weight:700;font-size:15px;flex-shrink:0;">${p.icon}</span><div style="flex:1;word-break:break-word;"></div><button style="background:none;border:0;color:#8a8799;cursor:pointer;font-size:18px;padding:0;line-height:1;flex-shrink:0;">×</button>`;
    el.querySelector('div').textContent = String(msg);
    c.appendChild(el);
    // animate in
    requestAnimationFrame(() => { el.style.transform = 'translateX(0)'; el.style.opacity = '1'; });

    const close = () => {
      el.style.transform = 'translateX(120%)'; el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    };
    el.querySelector('button').addEventListener('click', close);
    if (dur > 0) setTimeout(close, dur);
    return { close };
  }

  // ── Confirm modal ────────────────────────────────────────────────────────────
  function wdConfirm(message, opts) {
    const o = opts || {};
    const title       = o.title       || 'Potwierdź akcję';
    const confirmText = o.confirmText || 'Tak, kontynuuj';
    const cancelText  = o.cancelText  || 'Anuluj';
    const danger      = !!o.danger;

    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(8,8,16,0.72);backdrop-filter:blur(4px);z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;transition:opacity .15s ease;';
      const modal = document.createElement('div');
      modal.style.cssText = "background:#0d0d1a;border:1px solid rgba(201,168,76,0.25);border-radius:8px;max-width:440px;width:100%;padding:24px 28px;color:#f0ede8;font-family:'DM Sans',system-ui,Arial,sans-serif;box-shadow:0 24px 60px rgba(0,0,0,.6);transform:scale(.96);transition:transform .15s ease;";
      modal.innerHTML = `
        <h3 style="margin:0 0 12px;font-family:Georgia,serif;font-size:18px;font-weight:500;color:#f0ede8;letter-spacing:.02em;"></h3>
        <p style="margin:0 0 22px;font-size:14px;color:#a09da8;line-height:1.6;"></p>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button data-act="cancel"  style="background:transparent;color:#a09da8;border:1px solid rgba(255,255,255,.15);padding:9px 18px;border-radius:4px;cursor:pointer;font-size:13px;letter-spacing:.04em;text-transform:uppercase;font-weight:500;"></button>
          <button data-act="confirm" style="background:${danger?'#b03044':'#c9a84c'};color:${danger?'#fff':'#080810'};border:0;padding:9px 18px;border-radius:4px;cursor:pointer;font-size:13px;letter-spacing:.04em;text-transform:uppercase;font-weight:600;"></button>
        </div>`;
      modal.querySelector('h3').textContent = title;
      modal.querySelector('p').textContent  = message;
      modal.querySelector('[data-act="cancel"]').textContent  = cancelText;
      modal.querySelector('[data-act="confirm"]').textContent = confirmText;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      requestAnimationFrame(() => { overlay.style.opacity = '1'; modal.style.transform = 'scale(1)'; });

      const done = (v) => {
        overlay.style.opacity = '0'; modal.style.transform = 'scale(.96)';
        setTimeout(() => overlay.remove(), 150);
        document.removeEventListener('keydown', onKey);
        resolve(v);
      };
      const onKey = e => {
        if (e.key === 'Escape') done(false);
        else if (e.key === 'Enter') done(true);
      };
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
      modal.querySelector('[data-act="cancel"]').addEventListener('click', () => done(false));
      modal.querySelector('[data-act="confirm"]').addEventListener('click', () => done(true));
      modal.querySelector('[data-act="confirm"]').focus();
    });
  }

  // ── Convenience: handle fetch response ──────────────────────────────────────
  async function wdHandleResponse(res, opts) {
    const o = opts || {};
    let data; try { data = await res.json(); } catch { data = { ok: false, error: 'Bad response' }; }
    if (!res.ok || data.ok === false) {
      if (o.toast !== false) wdToast('error', wdErrorMessage(data, o.fallback));
      return { ok: false, data };
    }
    return { ok: true, data };
  }

  global.wdToast          = wdToast;
  global.wdConfirm        = wdConfirm;
  global.wdErrorMessage   = wdErrorMessage;
  global.wdHandleResponse = wdHandleResponse;
})(window);

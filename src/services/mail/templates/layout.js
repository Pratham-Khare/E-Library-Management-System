/**
 * The HTML shell every built-in template renders into, plus small builders for
 * the pieces templates repeat (buttons, detail tables, muted notes).
 */

import mailConfig from '../../../config/mail.js';

const { branding } = mailConfig;

/** Escape user-supplied values before interpolating them into HTML. */
export const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Wrap body content in the full email document.
 */
export const renderLayout = ({ title, bodyHtml, preheader = '' }) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

  <!-- Preheader: shown in the inbox preview line, hidden in the message body.
       Zero dimensions plus hidden overflow is the standard trick; there is no
       cleaner way that works across clients. -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f8;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e3e8ee;">

          <tr>
            <td style="background-color:${branding.primaryColor};padding:20px 28px;">
              <span style="color:#ffffff;font-size:17px;font-weight:600;letter-spacing:0.2px;">
                ${escapeHtml(branding.appName)}
              </span>
            </td>
          </tr>

          <tr>
            <td style="padding:28px;">
              <h1 style="margin:0 0 16px;font-size:20px;line-height:1.35;color:#1a1f36;font-weight:600;">
                ${escapeHtml(title)}
              </h1>
              ${bodyHtml}
            </td>
          </tr>

          <tr>
            <td style="padding:18px 28px;background-color:#fafbfc;border-top:1px solid #e3e8ee;">
              <p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:#6b7280;">
                ${escapeHtml(branding.footerNote)}
              </p>
              <p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280;">
                Questions? Reach us at
                <a href="mailto:${escapeHtml(branding.supportEmail)}" style="color:${branding.primaryColor};text-decoration:none;">${escapeHtml(branding.supportEmail)}</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

/** A paragraph of body text. */
export const paragraph = (text) =>
  `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#3c4257;">${text}</p>`;

/**
 * A call-to-action button.
 */
export const button = (label, url) => `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;">
    <tr>
      <td style="border-radius:6px;background-color:${branding.primaryColor};">
        <a href="${escapeHtml(url)}"
           style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">
          ${escapeHtml(label)}
        </a>
      </td>
    </tr>
  </table>`;

/**
 * A label/value detail table — due dates, fine amounts, book titles.
 * @param {Array<{label: string, value: string}>} rows
 */
export const detailTable = (rows) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="margin:18px 0;border:1px solid #e3e8ee;border-radius:6px;background-color:#fafbfc;">
    ${rows
      .map(
        ({ label, value }, index) => `
    <tr>
      <td style="padding:11px 16px;font-size:13px;color:#6b7280;${index > 0 ? 'border-top:1px solid #e3e8ee;' : ''}width:40%;">
        ${escapeHtml(label)}
      </td>
      <td style="padding:11px 16px;font-size:14px;color:#1a1f36;font-weight:500;${index > 0 ? 'border-top:1px solid #e3e8ee;' : ''}">
        ${escapeHtml(value)}
      </td>
    </tr>`
      )
      .join('')}
  </table>`;

/** Small muted text, for caveats and expiry notices. */
export const note = (text) =>
  `<p style="margin:14px 0 0;font-size:13px;line-height:1.55;color:#6b7280;">${text}</p>`;

/** An emphasised callout, for overdue notices and fines. */
export const alert = (text, tone = 'warning') => {
  const tones = {
    warning: { bg: '#fff8e6', border: '#f5c563', text: '#7a5b12' },
    danger: { bg: '#fdf0ef', border: '#f0a29c', text: '#8c2f28' },
    info: { bg: '#eef4ff', border: '#a8c4f5', text: '#1f4b99' },
  };
  const { bg, border, text: color } = tones[tone] ?? tones.warning;

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">
    <tr>
      <td style="padding:13px 16px;background-color:${bg};border-left:3px solid ${border};border-radius:4px;font-size:14px;line-height:1.55;color:${color};">
        ${text}
      </td>
    </tr>
  </table>`;
};

/** Build the plain-text alternative from a list of lines. */
export const renderText = (lines) =>
  [
    branding.appName,
    '='.repeat(branding.appName.length),
    '',
    ...lines,
    '',
    '—',
    branding.footerNote,
    `Questions? ${branding.supportEmail}`,
  ].join('\n');

export default { renderLayout, paragraph, button, detailTable, note, alert, renderText, escapeHtml };

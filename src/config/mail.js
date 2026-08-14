/**
 * EMAIL CONFIGURATION (SendGrid)
 * Two providers behind one interface:
 */

import env from './env.js';
import { NOTIFICATION_TYPE } from '../constants/enums.js';

export const PROVIDERS = Object.freeze({
  CONSOLE: 'console',
  SENDGRID: 'sendgrid',
});

/**
 * A key is unusable if it is blank or an obvious placeholder. SendGrid keys
 * always start with "SG." — anything else was never going to authenticate, so
 * we catch it at boot rather than on the first password-reset attempt.
 */
const isUsableApiKey = (key) => {
  if (!key) return false;
  const trimmed = key.trim();
  if (trimmed === '') return false;
  const placeholders = ['your-sendgrid-api-key', 'sg.xxxx', 'changeme', 'replace-me'];
  if (placeholders.includes(trimmed.toLowerCase())) return false;
  return trimmed.startsWith('SG.');
};

const requestedProvider = env.MAIL_PROVIDER;
const apiKeyUsable = isUsableApiKey(env.SENDGRID_API_KEY);

/**
 * Resolve the provider actually used, applying the fallback.
 * `fellBack` and `fallbackReason` are surfaced in the boot log and in the
 * /health/ready response so the current behaviour is never a guess.
 */
const resolution = (() => {
  if (!env.MAIL_ENABLED) {
    return {
      provider: PROVIDERS.CONSOLE,
      fellBack: false,
      reason: 'MAIL_ENABLED=false — outbound email is switched off; in-app notifications still work',
    };
  }
  if (requestedProvider === PROVIDERS.SENDGRID && !apiKeyUsable) {
    return {
      provider: PROVIDERS.CONSOLE,
      fellBack: true,
      reason:
        'MAIL_PROVIDER=sendgrid but SENDGRID_API_KEY is missing or invalid — emails will be written to the log instead. Add the key to .env to enable real delivery; no code change is needed.',
    };
  }
  if (requestedProvider === PROVIDERS.SENDGRID) {
    return {
      provider: PROVIDERS.SENDGRID,
      fellBack: false,
      reason: `Sending via SendGrid as ${env.MAIL_FROM_EMAIL}${env.SENDGRID_SANDBOX_MODE ? ' (SANDBOX MODE — nothing is actually delivered)' : ''}`,
    };
  }
  return {
    provider: PROVIDERS.CONSOLE,
    fellBack: false,
    reason: 'MAIL_PROVIDER=console — emails are written to the log',
  };
})();

/** The provider that will actually be used, after fallback. */
export const provider = resolution.provider;

/** True when SendGrid was requested but could not be used. */
export const fellBackToConsole = resolution.fellBack;

/** Human-readable explanation of the current mail configuration. */
export const providerReason = resolution.reason;

/** Whether any outbound email is attempted at all. */
export const enabled = env.MAIL_ENABLED;

/** SendGrid-specific settings. Ignored when the console provider is active. */
export const sendgrid = Object.freeze({
  apiKey: env.SENDGRID_API_KEY,
  /**
   * Sandbox mode validates the request and bills nothing but delivers nothing.
   * The right setting for testing the integration without spamming inboxes.
   */
  sandboxMode: env.SENDGRID_SANDBOX_MODE,
  /**
   * Optional Dynamic Template IDs (d-xxxxxxxx). When a type has no template
   * configured, the built-in HTML in services/mail/templates/ is used instead,
   * so email works out of the box with nothing set up in the dashboard.
   */
  templates: Object.freeze({
    [NOTIFICATION_TYPE.WELCOME]: env.SENDGRID_TEMPLATE_WELCOME,
    [NOTIFICATION_TYPE.PASSWORD_RESET]: env.SENDGRID_TEMPLATE_PASSWORD_RESET,
    [NOTIFICATION_TYPE.DUE_SOON]: env.SENDGRID_TEMPLATE_DUE_SOON,
    [NOTIFICATION_TYPE.OVERDUE]: env.SENDGRID_TEMPLATE_OVERDUE,
    [NOTIFICATION_TYPE.FINE_ISSUED]: env.SENDGRID_TEMPLATE_FINE_ISSUED,
  }),
});

/** Returns the Dynamic Template ID for a notification type, if configured. */
export const templateIdFor = (notificationType) => sendgrid.templates[notificationType] || null;

/**
 * The From identity. SendGrid rejects mail from an address that is not a
 * verified sender on the account, so this must match the dashboard.
 */
export const from = Object.freeze({
  email: env.MAIL_FROM_EMAIL,
  name: env.MAIL_FROM_NAME,
  replyTo: env.MAIL_REPLY_TO || env.MAIL_FROM_EMAIL,
});

/** Retry policy for transient SendGrid failures (5xx and 429). */
export const retry = Object.freeze({
  maxAttempts: 2,
  baseDelayMs: 1000,
  retryableStatuses: Object.freeze([429, 500, 502, 503, 504]),
});

/**
 * Values injected into every email template, so branding and links live in
 * one place rather than being repeated in each template file.
 */
export const branding = Object.freeze({
  appName: env.APP_NAME,
  appUrl: env.APP_URL.replace(/\/+$/, ''),
  supportEmail: from.replyTo,
  primaryColor: '#1f6feb',
  footerNote: 'You are receiving this because you have an account with this library.',
});

export default Object.freeze({
  PROVIDERS,
  provider,
  enabled,
  fellBackToConsole,
  providerReason,
  sendgrid,
  templateIdFor,
  from,
  retry,
  branding,
});

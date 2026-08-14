/**
 * ---------------------------------------------------------------------------
 * MAIL SERVICE
 * ---------------------------------------------------------------------------
 * The single entry point for outbound email. Callers never import a provider
 * directly:
 *
 *     await mailService.send(NOTIFICATION_TYPE.PASSWORD_RESET, user.email, { user, resetUrl });
 *
 * Which provider actually delivers is resolved at boot in config/mail.js — and
 * crucially, SendGrid FALLS BACK to the console provider when the API key is
 * missing or invalid. Nothing throws, nothing is skipped, and the caller does
 * not need to care. That is what lets the SendGrid key be added later as a pure
 * .env change.
 *
 * EMAIL FAILURE NEVER FAILS THE OPERATION. If SendGrid is down while someone
 * is registering, the registration must still succeed — the account is the
 * point, the welcome email is a courtesy. So `send()` resolves with
 * `{ success: false }` rather than rejecting, and every caller treats delivery
 * as best-effort. The one deliberate exception is the password-reset flow,
 * which checks the result: a reset the user can never receive is worse than an
 * honest error.
 * ---------------------------------------------------------------------------
 */

import mailConfig from '../../config/mail.js';
import logger from '../../utils/logger.js';
import { renderTemplate, hasTemplate } from './templates/index.js';
import consoleProvider from './providers/consoleProvider.js';

/**
 * The provider actually in use, from the RESOLVED configuration — which has
 * already applied the missing-key fallback.
 */
export const activeProviderName = mailConfig.provider;

/**
 * The SendGrid SDK is loaded LAZILY, and only when SendGrid is the chosen
 * provider. Importing it costs about half a second of startup, and in the
 * default configuration — no API key yet, so the console provider is active —
 * that is half a second spent loading an HTTP client that will never issue a
 * request. The console provider stays a static import because it is tiny and
 * is the fallback for every path.
 *
 * Resolved once and memoised, so the cost is paid on the first email at most.
 */
let providerPromise = null;

const getProvider = async () => {
  if (mailConfig.provider !== mailConfig.PROVIDERS.SENDGRID) return consoleProvider;

  if (!providerPromise) {
    providerPromise = import('./providers/sendgridProvider.js')
      .then((module) => module.default)
      .catch((error) => {
        // If the SDK cannot be loaded at all, degrade to console rather than
        // failing every email. Same principle as the missing-key fallback.
        logger.error('Could not load the SendGrid provider; falling back to console', {
          error: error.message,
        });
        return consoleProvider;
      });
  }

  return providerPromise;
};

logger.debug(`Mail service configured for the ${activeProviderName} provider`, {
  reason: mailConfig.providerReason,
});

/**
 * Render and send an email for a notification type.
 *
 * @param {string} type A NOTIFICATION_TYPE value.
 * @param {string} to Recipient address.
 * @param {object} data Template data — shape depends on the template.
 * @returns {Promise<{success: boolean, messageId: string|null, provider: string, skipped?: boolean, error?: string}>}
 */
export const send = async (type, to, data = {}) => {
  // Master switch: MAIL_ENABLED=false leaves in-app notifications working and
  // silences outbound email entirely.
  if (!mailConfig.enabled) {
    return { success: false, skipped: true, messageId: null, provider: 'disabled' };
  }

  if (!to) {
    logger.warn('Refusing to send an email with no recipient', { type });
    return { success: false, messageId: null, provider: activeProviderName, error: 'No recipient' };
  }

  // Not every notification type has an email representation — "book returned"
  // is in-app only by design. Not an error.
  if (!hasTemplate(type)) {
    logger.debug('No email template for this notification type; in-app only', { type });
    return { success: false, skipped: true, messageId: null, provider: activeProviderName };
  }

  try {
    const rendered = renderTemplate(type, data);
    const provider = await getProvider();

    const result = await provider.send({
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      type,
      // Passed through for a SendGrid Dynamic Template, if one is configured.
      data,
    });

    if (result.success) {
      logger.info('Email sent', {
        type,
        to,
        provider: result.provider,
        messageId: result.messageId,
        ...(result.sandbox ? { sandbox: true } : {}),
      });
    }

    return result;
  } catch (error) {
    // Reached only if a TEMPLATE throws — a provider failure is already caught
    // inside the provider. Either way, swallow it: see the note at the top.
    logger.error('Failed to render or send an email', {
      type,
      to,
      error: error.message,
      stack: error.stack,
    });
    return { success: false, messageId: null, provider: activeProviderName, error: error.message };
  }
};

/**
 * Send the same email to many recipients.
 *
 * Deliberately sequential with a small pause rather than a parallel burst:
 * SendGrid rate-limits, and the overnight due-reminder job can touch hundreds
 * of members at once. A burst that trips the limit costs far more time than
 * pacing does.
 *
 * @param {string} type
 * @param {Array<{to: string, data: object}>} recipients
 * @returns {Promise<{sent: number, failed: number}>}
 */
export const sendBulk = async (type, recipients) => {
  let sent = 0;
  let failed = 0;

  for (const { to, data } of recipients) {
    const result = await send(type, to, data);
    if (result.success) sent += 1;
    else if (!result.skipped) failed += 1;

    // Small pause between sends. Skipped for the console provider, where there
    // is no upstream to be polite to.
    if (activeProviderName === mailConfig.PROVIDERS.SENDGRID) {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  logger.info('Bulk email finished', { type, total: recipients.length, sent, failed });
  return { sent, failed };
};

/** Which provider is live, and why. Surfaced by the readiness probe. */
export const getProviderInfo = () => ({
  provider: activeProviderName,
  configured: !mailConfig.fellBackToConsole,
  enabled: mailConfig.enabled,
  reason: mailConfig.providerReason,
});

export const mailService = { send, sendBulk, getProviderInfo };

export default mailService;

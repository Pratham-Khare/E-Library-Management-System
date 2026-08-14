/**
 * The single entry point for outbound email. Callers never import a provider
 * directly:
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

/**
 * ---------------------------------------------------------------------------
 * SENDGRID MAIL PROVIDER
 * ---------------------------------------------------------------------------
 * Real delivery through the SendGrid v3 API.
 *
 * Two sending modes:
 *
 *   BUILT-IN TEMPLATE  — we render the HTML and text ourselves and hand
 *                        SendGrid a finished message. Works with nothing
 *                        configured in the dashboard.
 *   DYNAMIC TEMPLATE   — when a template ID is set for the notification type,
 *                        SendGrid renders it from `dynamicTemplateData`. Lets
 *                        non-developers edit email copy without a deploy.
 *
 * Errors are logged with SendGrid's own `response.body.errors`, which is where
 * the actionable detail lives. The single most common failure in practice is a
 * 403 for an unverified sender, and the generic message alone does not say so
 * — hence the explicit hint below.
 * ---------------------------------------------------------------------------
 */

import sgMail from '@sendgrid/mail';
import mailConfig from '../../../config/mail.js';
import logger from '../../../utils/logger.js';

let initialised = false;

/**
 * Configure the SDK on first use rather than at import time, so merely loading
 * this module (as the provider registry does) never throws on a missing key.
 */
const ensureInitialised = () => {
  if (initialised) return;
  sgMail.setApiKey(mailConfig.sendgrid.apiKey);
  initialised = true;
};

/** Retry only on transient failures — 429 and 5xx. A 400 or 403 will not fix itself. */
const isRetryable = (statusCode) => mailConfig.retry.retryableStatuses.includes(statusCode);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send an email.
 *
 * @param {object} message
 * @param {string} message.to
 * @param {string} message.subject
 * @param {string} message.text
 * @param {string} message.html
 * @param {string} [message.type] Notification type — selects a dynamic template.
 * @param {object} [message.data] Data for a dynamic template.
 * @returns {Promise<{success: boolean, messageId: string|null, provider: string, error?: string}>}
 */
export const send = async (message) => {
  ensureInitialised();

  const templateId = message.type ? mailConfig.templateIdFor(message.type) : null;

  const payload = {
    to: message.to,
    from: { email: mailConfig.from.email, name: mailConfig.from.name },
    replyTo: mailConfig.from.replyTo,

    // Sandbox mode validates the request and bills nothing, but delivers
    // nothing either — the right setting for testing the integration.
    ...(mailConfig.sendgrid.sandboxMode
      ? { mailSettings: { sandboxMode: { enable: true } } }
      : {}),

    ...(templateId
      ? // SendGrid renders it. Subject and body come from the template.
        { templateId, dynamicTemplateData: message.data ?? {} }
      : // We render it. Both parts are sent so the client can pick.
        { subject: message.subject, text: message.text, html: message.html }),
  };

  let lastError = null;

  for (let attempt = 0; attempt <= mailConfig.retry.maxAttempts; attempt += 1) {
    try {
      const [response] = await sgMail.send(payload);

      return {
        success: true,
        // SendGrid returns the queued message id in this header.
        messageId: response?.headers?.['x-message-id'] ?? null,
        provider: 'sendgrid',
        sandbox: mailConfig.sendgrid.sandboxMode,
      };
    } catch (error) {
      lastError = error;
      const statusCode = error?.code ?? error?.response?.statusCode;

      // The detail that actually explains the failure lives here, not in
      // error.message — which is usually just "Forbidden".
      const details = error?.response?.body?.errors ?? null;

      if (!isRetryable(statusCode) || attempt === mailConfig.retry.maxAttempts) {
        logger.error('SendGrid delivery failed', {
          to: message.to,
          subject: message.subject,
          statusCode,
          details,
          attempts: attempt + 1,
        });

        // By far the most common production failure, and the generic message
        // does not point at it.
        if (statusCode === 403) {
          logger.error(
            `SendGrid returned 403. The usual cause is that MAIL_FROM_EMAIL (${mailConfig.from.email}) is not a verified sender on the account. Verify it under Settings > Sender Authentication.`
          );
        }

        break;
      }

      const backoff = mailConfig.retry.baseDelayMs * 2 ** attempt;
      logger.warn(`SendGrid returned ${statusCode}; retrying in ${backoff}ms`, {
        to: message.to,
        attempt: attempt + 1,
      });
      await delay(backoff);
    }
  }

  return {
    success: false,
    messageId: null,
    provider: 'sendgrid',
    error: lastError?.message ?? 'Unknown SendGrid error',
  };
};

export default { send, name: 'sendgrid' };

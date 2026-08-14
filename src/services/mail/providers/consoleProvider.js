/**
 * Renders each email to the log instead of delivering it.
 */

import crypto from 'node:crypto';
import logger from '../../../utils/logger.js';

/**
 * @param {string} [message.type] Notification type, for the log.
 * @returns {Promise<{success: boolean, messageId: string, provider: string}>}
 */
export const send = async (message) => {
  // A synthetic id so the Notification document has something to record,
  // matching the shape a real provider returns.
  const messageId = `console-${crypto.randomUUID()}`;

  const divider = '─'.repeat(72);

  // console.log rather than the logger: this is a rendered artefact meant to
  // be read as a block, and winston would JSON-wrap it in production or prefix
  // every line with a timestamp.
  console.log(
    [
      '',
      divider,
      `  EMAIL (not sent — console provider)`,
      divider,
      `  To:      ${message.to}`,
      `  Subject: ${message.subject}`,
      ...(message.type ? [`  Type:    ${message.type}`] : []),
      divider,
      '',
      message.text ?? '(no plain-text body)',
      '',
      divider,
      '',
    ].join('\n')
  );

  logger.info('Email rendered to console', {
    to: message.to,
    subject: message.subject,
    type: message.type,
    messageId,
  });

  return { success: true, messageId, provider: 'console' };
};

export default { send, name: 'console' };

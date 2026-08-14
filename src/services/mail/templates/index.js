/**
 * ---------------------------------------------------------------------------
 * EMAIL TEMPLATES
 * ---------------------------------------------------------------------------
 * One render function per notification type. Each returns
 * `{ subject, html, text }` — never just HTML, because a plain-text
 * alternative is what keeps mail out of spam folders and readable in clients
 * that refuse HTML.
 *
 * These are the BUILT-IN templates, used when no SendGrid Dynamic Template ID
 * is configured for a type. That default matters: it means email works
 * immediately after `npm install`, with nothing set up in a SendGrid dashboard.
 * Configure a template ID in .env and SendGrid renders it instead, receiving
 * the same data as `dynamicTemplateData`.
 * ---------------------------------------------------------------------------
 */

import { NOTIFICATION_TYPE } from '../../../constants/enums.js';
import mailConfig from '../../../config/mail.js';
import libraryConfig from '../../../config/library.js';
import { renderLayout, paragraph, button, detailTable, note, alert, renderText, escapeHtml } from './layout.js';

const { branding } = mailConfig;

/** Consistent, unambiguous date formatting. "12 Mar 2026" beats "03/12/2026". */
const formatDate = (date) =>
  new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const formatMoney = (amount) => `${libraryConfig.fines.currency} ${Number(amount).toFixed(2)}`;

/** Plural agreement, so nothing reads "1 days overdue". */
const plural = (count, singular, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/* ===========================================================================
 * Templates
 * ======================================================================== */

/** Sent on registration. */
const welcome = ({ user }) => {
  const subject = `Welcome to ${branding.appName}`;

  const html = renderLayout({
    title: `Welcome, ${escapeHtml(user.name)}`,
    preheader: 'Your library account is ready to use.',
    bodyHtml: `
      ${paragraph('Your library account is ready. You can browse the catalogue, borrow books, and get AI-generated summaries to help you decide what to read next.')}
      ${detailTable([
        { label: 'Membership number', value: user.membershipNumber ?? '—' },
        { label: 'Membership type', value: user.membershipType },
        { label: 'Books at a time', value: String(libraryConfig.getPolicy(user.membershipType).maxActiveLoans) },
        { label: 'Loan period', value: plural(libraryConfig.getPolicy(user.membershipType).loanPeriodDays, 'day') },
      ])}
      ${button('Browse the catalogue', `${branding.appUrl}`)}
      ${note('Keep your membership number handy — the circulation desk uses it to identify your account.')}`,
  });

  const policy = libraryConfig.getPolicy(user.membershipType);
  const text = renderText([
    `Welcome, ${user.name}.`,
    '',
    'Your library account is ready.',
    '',
    `Membership number: ${user.membershipNumber ?? '—'}`,
    `Membership type:   ${user.membershipType}`,
    `Books at a time:   ${policy.maxActiveLoans}`,
    `Loan period:       ${plural(policy.loanPeriodDays, 'day')}`,
    '',
    `Browse the catalogue: ${branding.appUrl}`,
  ]);

  return { subject, html, text };
};

/**
 * Password reset. The most security-sensitive email the system sends, so it
 * states the expiry explicitly and tells a recipient who did not request it
 * that ignoring the message is sufficient — no action, no alarm.
 */
const passwordReset = ({ user, resetUrl, expiresInMinutes, requestIp }) => {
  const subject = 'Reset your password';

  const html = renderLayout({
    title: 'Reset your password',
    preheader: `This link expires in ${plural(expiresInMinutes, 'minute')}.`,
    bodyHtml: `
      ${paragraph(`Hello ${escapeHtml(user.name)}, we received a request to reset the password for your account.`)}
      ${button('Reset password', resetUrl)}
      ${paragraph(`Or paste this link into your browser:<br><span style="word-break:break-all;font-size:13px;color:#6b7280;">${escapeHtml(resetUrl)}</span>`)}
      ${alert(`This link expires in <strong>${plural(expiresInMinutes, 'minute')}</strong> and can only be used once.`, 'info')}
      ${note(
        `If you did not request this, you can safely ignore this email — your password will not change.${
          requestIp ? ` The request came from ${escapeHtml(requestIp)}.` : ''
        }`
      )}`,
  });

  const text = renderText([
    `Hello ${user.name},`,
    '',
    'We received a request to reset your password. Open this link to choose a new one:',
    '',
    resetUrl,
    '',
    `This link expires in ${plural(expiresInMinutes, 'minute')} and can only be used once.`,
    '',
    `If you did not request this, ignore this email — your password will not change.${
      requestIp ? ` The request came from ${requestIp}.` : ''
    }`,
  ]);

  return { subject, html, text };
};

/** Confirmation that a password changed — the tripwire for account takeover. */
const passwordChanged = ({ user, changedAt }) => {
  const subject = 'Your password was changed';

  const html = renderLayout({
    title: 'Your password was changed',
    preheader: 'If this was not you, contact the library immediately.',
    bodyHtml: `
      ${paragraph(`Hello ${escapeHtml(user.name)}, the password on your library account was changed on ${escapeHtml(formatDate(changedAt))}.`)}
      ${paragraph('You have been signed out on all other devices.')}
      ${alert(`If you did not make this change, contact us at <a href="mailto:${escapeHtml(branding.supportEmail)}" style="color:inherit;">${escapeHtml(branding.supportEmail)}</a> right away.`, 'danger')}`,
  });

  const text = renderText([
    `Hello ${user.name},`,
    '',
    `Your password was changed on ${formatDate(changedAt)}.`,
    'You have been signed out on all other devices.',
    '',
    `If this was not you, contact ${branding.supportEmail} right away.`,
  ]);

  return { subject, html, text };
};

/** Reminder ahead of a due date. Sent by the daily cron job. */
const dueSoon = ({ user, loans }) => {
  const count = loans.length;
  const subject = count === 1 ? `Due soon: ${loans[0].bookTitle}` : `${count} books due soon`;

  const html = renderLayout({
    title: count === 1 ? 'A book is due soon' : `${count} books are due soon`,
    preheader: 'Renew online if you need more time.',
    bodyHtml: `
      ${paragraph(`Hello ${escapeHtml(user.name)}, a quick reminder about ${count === 1 ? 'a book' : 'some books'} you have on loan.`)}
      ${detailTable(
        loans.map((loan) => ({
          label: loan.bookTitle,
          value: `Due ${formatDate(loan.dueAt)} (${plural(loan.daysRemaining, 'day')} left)`,
        }))
      )}
      ${paragraph(`You can renew online if you need more time — each renewal gives you another ${plural(libraryConfig.getPolicy(user.membershipType).loanPeriodDays, 'day')}.`)}
      ${button('View my loans', `${branding.appUrl}`)}
      ${note(
        `After the due date there is a ${plural(libraryConfig.fines.graceDays, 'day')} grace period, then a fine of ${formatMoney(libraryConfig.fines.perDay)} per day applies.`
      )}`,
  });

  const text = renderText([
    `Hello ${user.name},`,
    '',
    count === 1 ? 'A book you borrowed is due soon:' : `${count} books you borrowed are due soon:`,
    '',
    ...loans.map((loan) => `  • ${loan.bookTitle} — due ${formatDate(loan.dueAt)} (${plural(loan.daysRemaining, 'day')} left)`),
    '',
    'You can renew online if you need more time.',
    '',
    `After the due date there is a ${plural(libraryConfig.fines.graceDays, 'day')} grace period, then ${formatMoney(libraryConfig.fines.perDay)} per day applies.`,
  ]);

  return { subject, html, text };
};

/** Overdue notice, including the fine accrued so far. */
const overdue = ({ user, loans, totalFine }) => {
  const count = loans.length;
  const subject = count === 1 ? `Overdue: ${loans[0].bookTitle}` : `${count} overdue books`;

  const html = renderLayout({
    title: count === 1 ? 'You have an overdue book' : `You have ${count} overdue books`,
    preheader: 'A fine is accruing daily.',
    bodyHtml: `
      ${paragraph(`Hello ${escapeHtml(user.name)}, the following ${count === 1 ? 'item is' : 'items are'} past their due date.`)}
      ${detailTable(
        loans.map((loan) => ({
          label: loan.bookTitle,
          value: `${plural(loan.daysOverdue, 'day')} overdue — ${formatMoney(loan.fineAmount)}`,
        }))
      )}
      ${alert(
        `Total outstanding: <strong>${escapeHtml(formatMoney(totalFine))}</strong>. Fines accrue at ${escapeHtml(formatMoney(libraryConfig.fines.perDay))} per day, up to ${escapeHtml(formatMoney(libraryConfig.fines.maxPerLoan))} per book.`,
        'danger'
      )}
      ${paragraph(`Please return ${count === 1 ? 'it' : 'them'} as soon as you can. Borrowing is blocked once you owe more than ${escapeHtml(formatMoney(libraryConfig.fines.blockBorrowingAbove))}.`)}
      ${button('View my loans', `${branding.appUrl}`)}`,
  });

  const text = renderText([
    `Hello ${user.name},`,
    '',
    count === 1 ? 'A book you borrowed is overdue:' : `${count} books you borrowed are overdue:`,
    '',
    ...loans.map((loan) => `  • ${loan.bookTitle} — ${plural(loan.daysOverdue, 'day')} overdue, ${formatMoney(loan.fineAmount)}`),
    '',
    `Total outstanding: ${formatMoney(totalFine)}`,
    `Fines accrue at ${formatMoney(libraryConfig.fines.perDay)} per day, up to ${formatMoney(libraryConfig.fines.maxPerLoan)} per book.`,
    '',
    `Borrowing is blocked once you owe more than ${formatMoney(libraryConfig.fines.blockBorrowingAbove)}.`,
  ]);

  return { subject, html, text };
};

/** A fine has been raised against the account. */
const fineIssued = ({ user, fine, bookTitle }) => {
  const subject = `A fine of ${formatMoney(fine.amount)} has been added to your account`;

  const html = renderLayout({
    title: 'A fine has been added to your account',
    preheader: `${formatMoney(fine.amount)} for ${bookTitle}`,
    bodyHtml: `
      ${paragraph(`Hello ${escapeHtml(user.name)}, a fine has been recorded against your account.`)}
      ${detailTable([
        { label: 'Book', value: bookTitle },
        { label: 'Reason', value: fine.reason },
        { label: 'Amount', value: formatMoney(fine.amount) },
        ...(fine.daysOverdue ? [{ label: 'Days overdue', value: String(fine.daysOverdue) }] : []),
        { label: 'Total outstanding', value: formatMoney(user.stats?.outstandingFine ?? fine.amount) },
      ])}
      ${note(`Fines can be settled at the circulation desk. Borrowing is blocked while you owe more than ${escapeHtml(formatMoney(libraryConfig.fines.blockBorrowingAbove))}.`)}`,
  });

  const text = renderText([
    `Hello ${user.name},`,
    '',
    'A fine has been recorded against your account.',
    '',
    `Book:              ${bookTitle}`,
    `Reason:            ${fine.reason}`,
    `Amount:            ${formatMoney(fine.amount)}`,
    `Total outstanding: ${formatMoney(user.stats?.outstandingFine ?? fine.amount)}`,
    '',
    'Fines can be settled at the circulation desk.',
  ]);

  return { subject, html, text };
};

/** Staff suspended the account. */
const accountSuspended = ({ user, reason }) => {
  const subject = 'Your library account has been suspended';

  const html = renderLayout({
    title: 'Your account has been suspended',
    preheader: 'Contact the library to resolve this.',
    bodyHtml: `
      ${paragraph(`Hello ${escapeHtml(user.name)}, your library account has been suspended and you will not be able to sign in or borrow.`)}
      ${reason ? alert(`Reason: ${escapeHtml(reason)}`, 'warning') : ''}
      ${paragraph(`Please contact the library at <a href="mailto:${escapeHtml(branding.supportEmail)}" style="color:${branding.primaryColor};">${escapeHtml(branding.supportEmail)}</a> to resolve this.`)}`,
  });

  const text = renderText([
    `Hello ${user.name},`,
    '',
    'Your library account has been suspended. You will not be able to sign in or borrow.',
    ...(reason ? ['', `Reason: ${reason}`] : []),
    '',
    `Please contact ${branding.supportEmail} to resolve this.`,
  ]);

  return { subject, html, text };
};

/* ===========================================================================
 * Registry
 * ======================================================================== */

/**
 * Notification type -> renderer. A type absent from this map has no email
 * representation and is delivered in-app only, which is deliberate for
 * low-value events like "book returned".
 */
export const templates = Object.freeze({
  [NOTIFICATION_TYPE.WELCOME]: welcome,
  [NOTIFICATION_TYPE.PASSWORD_RESET]: passwordReset,
  [NOTIFICATION_TYPE.PASSWORD_CHANGED]: passwordChanged,
  [NOTIFICATION_TYPE.DUE_SOON]: dueSoon,
  [NOTIFICATION_TYPE.OVERDUE]: overdue,
  [NOTIFICATION_TYPE.FINE_ISSUED]: fineIssued,
  [NOTIFICATION_TYPE.ACCOUNT_SUSPENDED]: accountSuspended,
});

/**
 * Render an email for a notification type.
 * @returns {{subject: string, html: string, text: string}|null} null when the
 *   type has no email template — the caller then sends in-app only.
 */
export const renderTemplate = (type, data) => {
  const template = templates[type];
  if (!template) return null;
  return template(data);
};

export const hasTemplate = (type) => Boolean(templates[type]);

export default { templates, renderTemplate, hasTemplate };

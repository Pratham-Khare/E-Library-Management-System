/**
 * A winston logger configured from src/config/logger.js.
 */

import fs from 'node:fs';
import winston from 'winston';
import loggerConfig from '../config/logger.js';
import env from '../config/env.js';

const { combine, timestamp, printf, colorize, errors, json, splat } = winston.format;

/* Redaction */

const redactKeySet = new Set(loggerConfig.redactKeys.map((key) => key.toLowerCase()));
const dropKeySet = new Set(loggerConfig.dropKeys.map((key) => key.toLowerCase()));

/**
 * Recursively copies a value, replacing sensitive values and dropping bulky
 * ones. Cycles are handled with a WeakSet — a Mongoose document or an Express
 * request can easily contain one, and an unguarded walk would recurse forever.
 */
export const redact = (value, seen = new WeakSet(), depth = 0) => {
  // Guard against pathological nesting; 8 levels is far more than any log needs.
  if (depth > 8) return '[Object: max depth reached]';

  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.length > loggerConfig.maxStringLength
      ? `${value.slice(0, loggerConfig.maxStringLength)}… [truncated ${value.length - loggerConfig.maxStringLength} chars]`
      : value;
  }

  if (typeof value !== 'object') return value;

  // Errors are not plain objects — their message and stack are non-enumerable,
  // so a naive spread produces `{}`. Extract them explicitly.
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(loggerConfig.includeStack && value.stack ? { stack: value.stack } : {}),
      ...(value.code ? { code: value.code } : {}),
      ...(value.statusCode ? { statusCode: value.statusCode } : {}),
    };
  }

  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer: ${value.length} bytes]`;

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    // Cap array length so a 10,000-row bulk import does not become a log entry.
    const capped = value.length > 50 ? value.slice(0, 50) : value;
    const mapped = capped.map((item) => redact(item, seen, depth + 1));
    if (value.length > 50) mapped.push(`… and ${value.length - 50} more`);
    return mapped;
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (dropKeySet.has(lowerKey)) continue;
    output[key] = redactKeySet.has(lowerKey)
      ? loggerConfig.redactedPlaceholder
      : redact(item, seen, depth + 1);
  }
  return output;
};

/**
 * Winston format that runs redaction over every log entry's metadata.
 */
const redactFormat = winston.format((info) => {
  // Reserved string keys winston owns; everything else is caller metadata.
  const { level, message, timestamp: ts, stack, ...meta } = info;

  const safeMeta = redact(meta);

  // Mutate `info` in place — returning a new object drops winston's
  // Symbol(level), which colorize reads, and the first log line then throws.
  // Object.keys() returns string keys only, so those symbols survive.
  for (const key of Object.keys(meta)) delete info[key];
  Object.assign(info, safeMeta);

  return info;
});

/* Output formats */

/** Human-readable single lines for a terminal. */
const prettyFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  let line = `${ts} ${level}: ${message}`;

  const metaKeys = Object.keys(meta);
  if (metaKeys.length > 0) {
    // Compact one-liner when it fits; indented block when it does not.
    const serialised = JSON.stringify(meta);
    line += serialised.length <= 160 ? ` ${serialised}` : `\n${JSON.stringify(meta, null, 2)}`;
  }

  if (stack) line += `\n${stack}`;
  return line;
});

const developmentFormat = combine(
  errors({ stack: true }),
  redactFormat(),
  splat(),
  timestamp({ format: 'HH:mm:ss.SSS' }),
  colorize({ all: false, colors: loggerConfig.colors }),
  prettyFormat
);

const productionFormat = combine(
  errors({ stack: true }),
  redactFormat(),
  splat(),
  timestamp(),
  json()
);

/* Transports */

const transports = [
  new winston.transports.Console({
    // stderr for problems, stdout for everything else — the shell convention,
    // and what lets `npm start > out.log` keep errors visible.
    stderrLevels: ['error', 'warn'],
  }),
];

if (loggerConfig.files.enabled) {
  // Create the log directory up front: winston's file transport fails silently
  // if the directory is missing, which is a miserable thing to debug.
  try {
    fs.mkdirSync(loggerConfig.files.directory, { recursive: true });

    transports.push(
      new winston.transports.File({
        filename: loggerConfig.files.error,
        level: 'error',
        maxsize: loggerConfig.files.maxSizeBytes,
        maxFiles: loggerConfig.files.maxFiles,
        tailable: true,
      }),
      new winston.transports.File({
        filename: loggerConfig.files.combined,
        maxsize: loggerConfig.files.maxSizeBytes,
        maxFiles: loggerConfig.files.maxFiles,
        tailable: true,
      })
    );
  } catch (error) {
    console.warn(
      `[logger] Could not create log directory "${loggerConfig.files.directory}" — continuing with console output only. ${error.message}`
    );
  }
}

/* The logger */

winston.addColors(loggerConfig.colors);

const logger = winston.createLogger({
  level: loggerConfig.level,
  levels: loggerConfig.levels,
  format: loggerConfig.format === 'json' ? productionFormat : developmentFormat,
  transports,
  // Never let a logging failure take the process down.
  exitOnError: false,
  silent: env.NODE_ENV === 'test',
});

/**
 * A child logger that stamps every entry with fixed context, so a request's
 * log lines can be correlated without repeating the id at each call site.
 */
export const childLogger = (context) => logger.child(context);

/** Writable stream adapter so morgan can pipe HTTP logs through winston. */
export const httpStream = Object.freeze({
  write: (message) => logger.http(message.trim()),
});

/**
 * Prints a boxed startup banner. Worth the few lines: when someone runs
 * `npm run dev`, the answers to "which port, which database, is AI live, where
 * do emails go" should be visible immediately rather than requiring a hunt
 * through .env.
 */
export const banner = (title, rows) => {
  const width = 74;
  const line = '─'.repeat(width);

  // Pad short lines, and TRUNCATE long ones. Without the truncation a single
  // verbose value blows out the right-hand border and the box stops looking
  // like a box, which defeats the whole point of drawing one.
  const fit = (text) =>
    text.length > width ? `${text.slice(0, width - 1)}…` : text + ' '.repeat(width - text.length);

  const output = [
    '',
    `┌${line}┐`,
    `│${fit(`  ${title}`)}│`,
    `├${line}┤`,
    ...rows.map(({ label, value }) => `│${fit(`  ${label.padEnd(20)} ${value}`)}│`),
    `└${line}┘`,
    '',
  ];

  // Written directly rather than through winston: this is a human-facing
  // banner, not a log record, and it should not be JSON-wrapped in production.
  console.log(output.join('\n'));
};

export default logger;

// @ts-nocheck
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const LOG_DIRECTORY_NAME = process.env.APP_LOG_DIR || 'logs';
const LOG_FILE_NAMES = {
  request: 'requests.log',
  error: 'errors.log',
  payment: 'payments.log',
  dbQuery: 'db-queries.log',
};

function resolveLogDirectory() {
  if (process.env.VERCEL) {
    return path.join(os.tmpdir(), 'surevideotool', LOG_DIRECTORY_NAME);
  }

  return path.resolve(process.cwd(), LOG_DIRECTORY_NAME);
}

function ensureLogDirectory() {
  fs.mkdirSync(resolveLogDirectory(), { recursive: true });
  return resolveLogDirectory();
}

function serializeError(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name,
    message: error.message,
    code: error.code || error?.cause?.code || null,
    stack: error.stack,
    cause: error.cause ? serializeError(error.cause) : null,
  };
}

function sanitizeValue(value, seen = new WeakSet()) {
  if (value instanceof Error) {
    return serializeError(value);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen));
  }

  const output = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = sanitizeValue(nestedValue, seen);
  }

  return output;
}

function appendLog(fileName, payload) {
  const directory = ensureLogDirectory();
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), ...sanitizeValue(payload) });
  fs.appendFileSync(path.join(directory, fileName), `${entry}\n`, 'utf8');
}

export function createRequestId() {
  return crypto.randomUUID();
}

export function logRequest(payload) {
  appendLog(LOG_FILE_NAMES.request, payload);
}

export function logError(event, error, context = {}) {
  appendLog(LOG_FILE_NAMES.error, {
    event,
    error: serializeError(error),
    context,
  });
}

export function logPayment(payload) {
  appendLog(LOG_FILE_NAMES.payment, payload);
}

export function logDbQuery(payload) {
  appendLog(LOG_FILE_NAMES.dbQuery, payload);
}

export function summarizeResponseBody(body) {
  if (body === null || body === undefined) {
    return null;
  }

  if (typeof body === 'string') {
    return body.length > 300 ? `${body.slice(0, 300)}...` : body;
  }

  return sanitizeValue(body);
}

export function getLogFilePaths() {
  const directory = ensureLogDirectory();

  return {
    request: path.join(directory, LOG_FILE_NAMES.request),
    error: path.join(directory, LOG_FILE_NAMES.error),
    payment: path.join(directory, LOG_FILE_NAMES.payment),
    dbQuery: path.join(directory, LOG_FILE_NAMES.dbQuery),
  };
}
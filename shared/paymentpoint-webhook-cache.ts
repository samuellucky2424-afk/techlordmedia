// @ts-nocheck
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logPayment } from './server-logger.js';

const CACHE_DIRECTORY_NAME = process.env.APP_LOG_DIR || 'logs';
const CACHE_FILE_NAME = 'paymentpoint-webhooks.json';

function resolveCachePath() {
  if (process.env.VERCEL) {
    return path.join(os.tmpdir(), 'surevideotool', CACHE_DIRECTORY_NAME, CACHE_FILE_NAME);
  }

  return path.resolve(process.cwd(), CACHE_DIRECTORY_NAME, CACHE_FILE_NAME);
}

function ensureCacheDirectory() {
  fs.mkdirSync(path.dirname(resolveCachePath()), { recursive: true });
}

function normalizeString(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (value === null || value === undefined) {
    return null;
  }

  const coerced = String(value).trim();
  return coerced.length > 0 ? coerced : null;
}

function normalizeEmail(value) {
  const normalized = normalizeString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function amountsMatch(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.01;
}

function readCacheFile() {
  try {
    const cachePath = resolveCachePath();
    if (!fs.existsSync(cachePath)) {
      return [];
    }

    const contents = fs.readFileSync(cachePath, 'utf8');
    if (!contents.trim()) {
      return [];
    }

    const parsed = JSON.parse(contents);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCacheFile(cache) {
  ensureCacheDirectory();
  fs.writeFileSync(resolveCachePath(), JSON.stringify(cache, null, 2), 'utf8');
}

export function savePaymentPointWebhookEvent(payload) {
  const entry = {
    receivedAt: new Date().toISOString(),
    transactionId: normalizeString(payload?.transaction_id),
    amountPaidNGN: toFiniteNumber(payload?.amount_paid),
    notificationStatus: String(payload?.notification_status || '').toLowerCase(),
    transactionStatus: String(payload?.transaction_status || '').toLowerCase(),
    customerEmail: normalizeEmail(payload?.customer?.email),
    customerId: normalizeString(payload?.customer?.customer_id),
    receiverAccountNumber: normalizeString(payload?.receiver?.account_number),
    receiverBank: normalizeString(payload?.receiver?.bank),
    description: normalizeString(payload?.description),
    timestamp: normalizeString(payload?.timestamp),
    payload,
  };

  const cache = readCacheFile();
  const filtered = cache.filter((item) => item.transactionId !== entry.transactionId);
  filtered.push(entry);
  writeCacheFile(filtered.slice(-200));

  logPayment({
    event: 'paymentpoint-webhook-cache-save',
    transactionId: entry.transactionId,
    customerEmail: entry.customerEmail,
    receiverAccountNumber: entry.receiverAccountNumber,
    amountPaidNGN: entry.amountPaidNGN,
  });

  return entry;
}

export function findLatestSuccessfulPaymentPointWebhook({
  customerEmail,
  customerId,
  receiverAccountNumber,
  amountPaidNGN,
  createdAfter,
}) {
  const normalizedCustomerEmail = normalizeEmail(customerEmail);
  const normalizedCustomerId = normalizeString(customerId);
  const normalizedReceiverAccountNumber = normalizeString(receiverAccountNumber);
  const normalizedAmount = toFiniteNumber(amountPaidNGN);
  const createdAfterTimestamp = createdAfter ? Date.parse(createdAfter) : null;

  const matches = readCacheFile()
    .filter((entry) => {
      if (!entry) {
        return false;
      }

      if (!['payment_successful', ''].includes(String(entry.notificationStatus || '').toLowerCase())) {
        return false;
      }

      if (!['success', 'successful', 'succeeded', ''].includes(String(entry.transactionStatus || '').toLowerCase())) {
        return false;
      }

      if (normalizedCustomerId && entry.customerId && entry.customerId !== normalizedCustomerId) {
        return false;
      }

      if (normalizedCustomerEmail && entry.customerEmail && entry.customerEmail !== normalizedCustomerEmail) {
        return false;
      }

      if (normalizedReceiverAccountNumber && entry.receiverAccountNumber && entry.receiverAccountNumber !== normalizedReceiverAccountNumber) {
        return false;
      }

      if (normalizedAmount !== null && entry.amountPaidNGN !== null && !amountsMatch(entry.amountPaidNGN, normalizedAmount)) {
        return false;
      }

      if (createdAfterTimestamp) {
        const candidateTimestamp = Date.parse(entry.timestamp || entry.receivedAt || '');
        if (Number.isFinite(candidateTimestamp) && candidateTimestamp < createdAfterTimestamp) {
          return false;
        }
      }

      return true;
    })
    .sort((left, right) => Date.parse(right.timestamp || right.receivedAt || '') - Date.parse(left.timestamp || left.receivedAt || ''));

  const match = matches[0] || null;
  if (match) {
    logPayment({
      event: 'paymentpoint-webhook-cache-hit',
      transactionId: match.transactionId,
      customerEmail: match.customerEmail,
      receiverAccountNumber: match.receiverAccountNumber,
      amountPaidNGN: match.amountPaidNGN,
    });
  }

  return match;
}

export function getPaymentPointWebhookCachePath() {
  ensureCacheDirectory();
  return resolveCachePath();
}
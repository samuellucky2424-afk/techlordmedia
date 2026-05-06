// @ts-nocheck
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logPayment } from './server-logger.js';

const CACHE_DIRECTORY_NAME = process.env.APP_LOG_DIR || 'logs';
const CACHE_FILE_NAME = 'paymentpoint-virtual-accounts.json';

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

function readCacheFile() {
  try {
    const cachePath = resolveCachePath();
    if (!fs.existsSync(cachePath)) {
      return {};
    }

    const contents = fs.readFileSync(cachePath, 'utf8');
    if (!contents.trim()) {
      return {};
    }

    const parsed = JSON.parse(contents);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeCacheFile(cache) {
  ensureCacheDirectory();
  fs.writeFileSync(resolveCachePath(), JSON.stringify(cache, null, 2), 'utf8');
}

function buildCacheKey({ email, businessId }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedBusinessId = normalizeString(businessId);

  if (!normalizedEmail || !normalizedBusinessId) {
    return null;
  }

  return `${normalizedBusinessId}::${normalizedEmail}`;
}

export function getCachedPaymentPointVirtualAccount({ email, businessId }) {
  const cacheKey = buildCacheKey({ email, businessId });
  if (!cacheKey) {
    return null;
  }

  const cache = readCacheFile();
  const entry = cache[cacheKey] || null;

  if (entry) {
    logPayment({
      event: 'paymentpoint-virtual-account-cache-hit',
      cacheKey,
      customerEmail: normalizeEmail(email),
      bankAccountCount: Array.isArray(entry.bankAccounts) ? entry.bankAccounts.length : 0,
    });
  }

  return entry;
}

export function saveCachedPaymentPointVirtualAccount({ email, businessId, payload }) {
  const cacheKey = buildCacheKey({ email, businessId });
  if (!cacheKey || !payload) {
    return null;
  }

  const cache = readCacheFile();
  const nextEntry = {
    cachedAt: new Date().toISOString(),
    customerEmail: normalizeEmail(email),
    businessId: normalizeString(businessId),
    customer: payload.customer || null,
    business: payload.business || null,
    bankAccounts: Array.isArray(payload.bankAccounts) ? payload.bankAccounts : [],
    errors: Array.isArray(payload.errors) ? payload.errors : [],
    message: payload.message || null,
  };

  cache[cacheKey] = nextEntry;
  writeCacheFile(cache);

  logPayment({
    event: 'paymentpoint-virtual-account-cache-save',
    cacheKey,
    customerEmail: normalizeEmail(email),
    bankAccountCount: nextEntry.bankAccounts.length,
  });

  return nextEntry;
}

export function getPaymentPointVirtualAccountCachePath() {
  ensureCacheDirectory();
  return resolveCachePath();
}
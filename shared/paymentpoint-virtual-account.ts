// @ts-nocheck
import { getCachedPaymentPointVirtualAccount, saveCachedPaymentPointVirtualAccount } from './paymentpoint-virtual-account-cache.js';
import { logPayment } from './server-logger.js';

const PAYMENTPOINT_CREATE_VIRTUAL_ACCOUNT_URL = 'https://api.paymentpoint.co/api/v1/createVirtualAccount';
const DEFAULT_PAYMENTPOINT_BANK_CODES = ['20946', '20897'];
const PAYMENTPOINT_REQUEST_TIMEOUT_MS = 30000;
const PAYMENTPOINT_REQUEST_ATTEMPTS = 3;
const RETRYABLE_PAYMENTPOINT_ERROR_CODES = new Set([
  '23',
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const RETRYABLE_PAYMENTPOINT_ERROR_NAMES = new Set([
  'AbortError',
  'TimeoutError',
]);

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

function normalizeBankCodes(value) {
  const values = Array.isArray(value)
    ? value
    : normalizeString(value)?.split(',') || [];

  const normalized = values
    .map((item) => normalizeString(item))
    .filter(Boolean);

  return normalized.length > 0 ? normalized : [...DEFAULT_PAYMENTPOINT_BANK_CODES];
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function getPaymentPointErrorCode(error) {
  const directCode = normalizeString(error?.code);
  if (directCode) {
    return directCode;
  }

  return normalizeString(error?.cause?.code);
}

function getPaymentPointErrorName(error) {
  const directName = normalizeString(error?.name);
  if (directName) {
    return directName;
  }

  return normalizeString(error?.cause?.name);
}

function isPaymentPointTimeoutError(error) {
  const code = getPaymentPointErrorCode(error);
  const name = getPaymentPointErrorName(error);
  const message = normalizeString(error?.message) || normalizeString(error?.cause?.message) || '';

  return code === '23'
    || name === 'TimeoutError'
    || /timeout/i.test(message);
}

function isRetryablePaymentPointError(error) {
  const code = getPaymentPointErrorCode(error);
  const name = getPaymentPointErrorName(error);

  if (isPaymentPointTimeoutError(error)) {
    return true;
  }

  return Boolean(
    (code && RETRYABLE_PAYMENTPOINT_ERROR_CODES.has(code))
      || (name && RETRYABLE_PAYMENTPOINT_ERROR_NAMES.has(name))
  );
}

function buildPaymentPointTransportError(error) {
  const code = getPaymentPointErrorCode(error);
  const message = isPaymentPointTimeoutError(error)
    ? 'PaymentPoint request timed out. Please try again.'
    : code
      ? `PaymentPoint connection failed (${code}). Please try again.`
      : 'PaymentPoint connection failed. Please try again.';
  const wrappedError = new Error(message);
  wrappedError.statusCode = 502;
  wrappedError.cause = error;
  return wrappedError;
}

async function requestPaymentPointVirtualAccount(payload, apiKey, secretKey) {
  let lastError = null;

  for (let attempt = 1; attempt <= PAYMENTPOINT_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(PAYMENTPOINT_CREATE_VIRTUAL_ACCOUNT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          Connection: 'close',
          'Content-Type': 'application/json',
          'api-key': apiKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PAYMENTPOINT_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error;
      if (!isRetryablePaymentPointError(error) || attempt === PAYMENTPOINT_REQUEST_ATTEMPTS) {
        throw buildPaymentPointTransportError(error);
      }

      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }

  throw buildPaymentPointTransportError(lastError);
}

export function resolvePaymentPointVirtualAccountConfig(env = process.env) {
  const apiKey = normalizeString(env.PAYMENTPOINT_API_KEY);
  const secretKey = normalizeString(env.PAYMENTPOINT_SECRET_KEY);
  const businessId = normalizeString(env.PAYMENTPOINT_BUSINESS_ID) || apiKey;
  const bankCodes = normalizeBankCodes(env.PAYMENTPOINT_BANK_CODES);

  const configError = !apiKey
    ? 'Missing PAYMENTPOINT_API_KEY'
    : !secretKey
      ? 'Missing PAYMENTPOINT_SECRET_KEY'
      : !businessId
        ? 'Missing PAYMENTPOINT_BUSINESS_ID'
        : null;

  return {
    apiKey,
    secretKey,
    businessId,
    bankCodes,
    configError,
  };
}

export async function createPaymentPointVirtualAccount({
  email,
  name,
  phoneNumber,
  bankCodes,
  apiKey,
  secretKey,
  businessId,
}) {
  const normalizedEmail = normalizeString(email)?.toLowerCase();
  const normalizedName = normalizeString(name);
  const normalizedPhoneNumber = normalizeString(phoneNumber);
  const normalizedBusinessId = normalizeString(businessId) || normalizeString(apiKey);
  const normalizedBankCodes = normalizeBankCodes(bankCodes);
  const cachedAccount = getCachedPaymentPointVirtualAccount({
    email: normalizedEmail,
    businessId: normalizedBusinessId,
  });

  if (!normalizedEmail || !normalizedName || !normalizedPhoneNumber) {
    throw new Error('Missing email, name, or phone number for virtual account creation');
  }

  if (!normalizeString(apiKey) || !normalizeString(secretKey) || !normalizedBusinessId) {
    throw new Error('PaymentPoint credentials are not configured');
  }

  if (cachedAccount?.bankAccounts?.length) {
    logPayment({
      event: 'paymentpoint-virtual-account-reused',
      customerEmail: normalizedEmail,
      businessId: normalizedBusinessId,
      bankAccountCount: cachedAccount.bankAccounts.length,
    });

    return {
      status: 'success',
      message: 'Existing PaymentPoint virtual account reused for this customer.',
      customer: cachedAccount.customer,
      business: cachedAccount.business,
      bankAccounts: cachedAccount.bankAccounts,
      errors: cachedAccount.errors || [],
      reused: true,
      cachedAt: cachedAccount.cachedAt || null,
    };
  }

  logPayment({
    event: 'paymentpoint-virtual-account-create-attempt',
    customerEmail: normalizedEmail,
    businessId: normalizedBusinessId,
    bankCodes: normalizedBankCodes,
  });

  const response = await requestPaymentPointVirtualAccount({
      email: normalizedEmail,
      name: normalizedName,
      phoneNumber: normalizedPhoneNumber,
      bankCode: normalizedBankCodes,
      businessId: normalizedBusinessId,
    }, apiKey, secretKey);

  const data = await parseResponseBody(response);
  const bankAccounts = Array.isArray(data?.bankAccounts) ? data.bankAccounts : [];

  if (!response.ok || String(data?.status || '').toLowerCase() !== 'success' || bankAccounts.length === 0) {
    const remoteMessage = normalizeString(data?.message)
      || normalizeString(data?.error)
      || normalizeString(data?.raw)
      || `PaymentPoint returned HTTP ${response.status}`;
    const error = new Error(remoteMessage);
    error.statusCode = response.status;
    error.responseBody = data;
    logPayment({
      event: 'paymentpoint-virtual-account-create-failed',
      customerEmail: normalizedEmail,
      businessId: normalizedBusinessId,
      responseStatus: response.status,
      message: remoteMessage,
    });
    throw error;
  }

  const result = {
    ...data,
    customer: data?.customer && typeof data.customer === 'object' ? data.customer : null,
    business: data?.business && typeof data.business === 'object' ? data.business : null,
    bankAccounts,
    errors: Array.isArray(data?.errors) ? data.errors : [],
  };

  saveCachedPaymentPointVirtualAccount({
    email: normalizedEmail,
    businessId: normalizedBusinessId,
    payload: result,
  });

  logPayment({
    event: 'paymentpoint-virtual-account-create-success',
    customerEmail: normalizedEmail,
    businessId: normalizedBusinessId,
    bankAccountCount: bankAccounts.length,
  });

  return result;
}

export { DEFAULT_PAYMENTPOINT_BANK_CODES };
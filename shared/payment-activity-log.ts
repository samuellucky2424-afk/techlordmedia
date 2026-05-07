// @ts-nocheck
import crypto from 'crypto';

import { logError, logPayment } from './server-logger.js';

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

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

export function parseJsonBody(rawBody) {
  try {
    return JSON.parse(rawBody || '{}');
  } catch {
    return null;
  }
}

export function summarizeHeaders(headers = {}) {
  const interestingHeaders = [
    'content-type',
    'paymentpoint-signature',
    'x-paymentpoint-signature',
    'x-payment-point-signature',
    'signature',
    'user-agent',
  ];

  return Object.fromEntries(
    interestingHeaders.map((name) => {
      const value = headers?.[name] ?? headers?.[name.toLowerCase()];
      const normalizedValue = Array.isArray(value) ? value[0] : value;
      return [
        name,
        /signature/i.test(name)
          ? { present: Boolean(normalizedValue), sha256: normalizedValue ? sha256(normalizedValue).slice(0, 16) : null }
          : normalizeString(normalizedValue),
      ];
    }),
  );
}

export function summarizePaymentPointPayload(payload = {}) {
  const customer = payload?.customer && typeof payload.customer === 'object' ? payload.customer : {};
  const receiver = payload?.receiver && typeof payload.receiver === 'object' ? payload.receiver : {};
  const metadata = payload?.metadata && typeof payload.metadata === 'object'
    ? payload.metadata
    : (payload?.meta && typeof payload.meta === 'object' ? payload.meta : {});

  return {
    transactionId: normalizeString(payload?.transaction_id),
    amountPaidNGN: toFiniteNumber(payload?.amount_paid),
    settlementAmountNGN: toFiniteNumber(payload?.settlement_amount),
    notificationStatus: normalizeString(payload?.notification_status),
    transactionStatus: normalizeString(payload?.transaction_status),
    description: normalizeString(payload?.description),
    timestamp: normalizeString(payload?.timestamp),
    customer: {
      id: normalizeString(customer?.customer_id),
      email: normalizeString(customer?.email)?.toLowerCase(),
      name: normalizeString(customer?.name || customer?.customer_name),
      phone: normalizeString(customer?.phone || customer?.phone_number || customer?.customer_phone_number),
    },
    receiver: {
      accountNumber: normalizeString(receiver?.account_number),
      bank: normalizeString(receiver?.bank),
    },
    metadata: safeJson(metadata, {}),
  };
}

export async function logPaymentActivity(supabaseAdmin, {
  event,
  severity = 'info',
  provider = 'PaymentPoint',
  userId = null,
  reference = null,
  targetId = null,
  statusCode = null,
  message = null,
  payload = {},
} = {}) {
  const entry = {
    event,
    severity,
    provider,
    userId,
    reference,
    statusCode,
    message,
    ...safeJson(payload, {}),
  };

  logPayment({
    event: 'payment-activity',
    ...entry,
  });

  if (!supabaseAdmin) {
    return;
  }

  try {
    const { error } = await supabaseAdmin.from('audit_log').insert({
      actor_id: null,
      action: 'payment_activity',
      target_table: 'payments',
      target_id: normalizeString(targetId || reference || userId),
      payload: entry,
    });

    if (error) {
      logError('payment-activity-audit-log-insert-failed', error, { event, reference, userId });
    }
  } catch (error) {
    logError('payment-activity-audit-log-unexpected-error', error, { event, reference, userId });
  }
}

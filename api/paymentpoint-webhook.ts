// @ts-nocheck
import crypto from 'crypto';

import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import { savePaymentPointWebhookEvent } from '../shared/paymentpoint-webhook-cache.js';
import { logError, logPayment } from '../shared/server-logger.js';
import {
  applyVerifiedPayment,
  resolvePaymentPointUserId,
  validatePaymentPointNotification,
} from '../shared/paymentpoint-payment.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

function getHeader(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function readRawBody(req) {
  if (typeof req.body === 'string') {
    return req.body;
  }

  if (Buffer.isBuffer(req.body)) {
    return req.body.toString('utf8');
  }

  if (req.body && typeof req.body === 'object') {
    return JSON.stringify(req.body);
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function hasValidPaymentPointSignature(rawBody, signature, secretKey) {
  if (!rawBody || !signature || !secretKey) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secretKey)
    .update(rawBody)
    .digest('hex');

  const normalizedExpected = expected.toLowerCase();
  const normalizedSignature = String(signature).trim().toLowerCase();
  if (normalizedExpected.length !== normalizedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(normalizedExpected, 'utf8'),
    Buffer.from(normalizedSignature, 'utf8'),
  );
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Paymentpoint-Signature');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabaseAdmin) {
    return res.status(503).json({ status: 'failed', message: supabaseAdminConfigError });
  }

  const paymentPointSecretKey =
    process.env.PAYMENTPOINT_SECRET_KEY ||
    process.env.PAYMENTPOINT_WEBHOOK_SECRET ||
    process.env.PAYMENTPOINT_SECURITY_KEY;

  if (!paymentPointSecretKey) {
    return res.status(500).json({ status: 'failed', message: 'Missing PaymentPoint secret configuration' });
  }

  try {
    const rawBody = await readRawBody(req);
    const signature = getHeader(req, 'paymentpoint-signature') || getHeader(req, 'Paymentpoint-Signature');
    if (!hasValidPaymentPointSignature(rawBody, signature, paymentPointSecretKey)) {
      logPayment({ event: 'paymentpoint-webhook-invalid-signature', scope: 'root-api' });
      return res.status(401).json({ status: 'failed', message: 'Invalid PaymentPoint signature' });
    }

    const payload = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
      ? req.body
      : JSON.parse(rawBody || '{}');

    savePaymentPointWebhookEvent(payload);

    const validation = validatePaymentPointNotification(payload);
    if (!validation.ok) {
      if (validation.ignore) {
        logPayment({ event: 'paymentpoint-webhook-ignored', scope: 'root-api', message: validation.message });
        return res.status(200).json({ received: true, ignored: true, message: validation.message });
      }

      return res.status(400).json({ status: 'failed', message: validation.message });
    }

    const userResolution = await resolvePaymentPointUserId(supabaseAdmin, validation.context.customer);
    if (!userResolution.userId) {
      return res.status(400).json({
        status: 'failed',
        message: 'Unable to map PaymentPoint customer to an application user',
        customerEmail: userResolution.customerEmail,
      });
    }

    const result = await applyVerifiedPayment(supabaseAdmin, {
      reference: validation.context.reference,
      userId: userResolution.userId,
      credits: validation.context.credits,
      amountPaidNGN: validation.context.amountPaidNGN,
      description: validation.context.description || `PaymentPoint payment from ${userResolution.customerEmail || 'customer'}`,
      provider: 'PaymentPoint',
    });

    logPayment({
      event: 'paymentpoint-webhook-processed',
      scope: 'root-api',
      reference: validation.context.reference,
      userId: userResolution.userId,
      amountPaidNGN: validation.context.amountPaidNGN,
      credits: validation.context.credits,
      result,
    });

    return res.status(200).json({ received: true, processed: true, ...result });
  } catch (error) {
    console.error('[api/paymentpoint-webhook] unexpected error:', error);
    logError('paymentpoint-webhook-unexpected-error', error, { scope: 'root-api' });
    return res.status(500).json({ status: 'failed', message: 'Internal server error' });
  }
}

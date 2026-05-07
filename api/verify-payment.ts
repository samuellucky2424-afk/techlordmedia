// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import { findLatestSuccessfulPaymentPointWebhook } from '../shared/paymentpoint-webhook-cache.js';
import { logPaymentActivity } from '../shared/payment-activity-log.js';
import { logError, logPayment } from '../shared/server-logger.js';
import {
  applyVerifiedPayment,
  getProcessedPaymentStatus,
  resolvePaymentPointUserId,
  validatePaymentPointNotification,
} from '../shared/paymentpoint-payment.js';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ status: 'failed', message: supabaseAdminConfigError });

  const {
    reference,
    transactionId,
    userId,
    customerEmail,
    customerId,
    receiverAccountNumber,
    amountNGN,
    credits,
    createdAfter,
  } = req.body || {};
  const lookupReference = reference || transactionId;

  if ((!lookupReference && !customerEmail && !customerId) || (!userId && !customerEmail)) {
    await logPaymentActivity(supabaseAdmin, {
      event: 'payment_verify_rejected_missing_data',
      severity: 'warning',
      reference: lookupReference,
      userId,
      statusCode: 400,
      message: 'Missing PaymentPoint verification data',
      payload: { customerEmail, customerId, receiverAccountNumber, amountNGN, credits, createdAfter },
    });
    return res.status(400).json({
      status: 'failed',
      message: 'Missing PaymentPoint verification data',
    });
  }

  try {
    const userResolution = await resolvePaymentPointUserId(
      supabaseAdmin,
      { email: customerEmail, customer_id: customerId },
      userId,
    );

    if (!userResolution.userId) {
      await logPaymentActivity(supabaseAdmin, {
        event: 'payment_verify_user_mapping_failed',
        severity: 'warning',
        reference: lookupReference,
        targetId: lookupReference || customerEmail,
        statusCode: 400,
        message: 'Unable to resolve the PaymentPoint customer to a user',
        payload: {
          customerEmail,
          customerId,
          resolutionSource: userResolution.source,
        },
      });
      return res.status(400).json({
        status: 'failed',
        message: 'Unable to resolve the PaymentPoint customer to a user',
      });
    }

    let result;

    if (lookupReference) {
      result = await getProcessedPaymentStatus(supabaseAdmin, {
        reference: lookupReference,
        userId: userResolution.userId,
      });
    } else {
      const matchedWebhook = findLatestSuccessfulPaymentPointWebhook({
        customerEmail,
        customerId,
        receiverAccountNumber,
        amountPaidNGN: amountNGN,
        createdAfter,
      });

      if (!matchedWebhook?.payload) {
        result = {
          status: 'pending',
          message: 'Waiting for PaymentPoint transfer confirmation',
        };
      } else {
        const validation = validatePaymentPointNotification(matchedWebhook.payload);
        if (!validation.ok) {
          result = {
            status: 'pending',
            message: validation.message || 'Waiting for PaymentPoint transfer confirmation',
          };
        } else {
          result = await applyVerifiedPayment(supabaseAdmin, {
            reference: validation.context.reference,
            userId: userResolution.userId,
            credits: credits || validation.context.credits,
            amountPaidNGN: validation.context.amountPaidNGN,
            description: validation.context.description || `PaymentPoint payment from ${customerEmail || 'customer'}`,
            provider: 'PaymentPoint',
          });

          result = {
            ...result,
            transactionId: validation.context.transactionId,
            verifiedFrom: 'webhook-cache',
          };
        }
      }
    }

    logPayment({
      event: 'paymentpoint-verify-payment',
      scope: 'root-api',
      reference: lookupReference,
      userId: userResolution.userId,
      customerEmail,
      receiverAccountNumber,
      amountNGN,
      result,
    });

    await logPaymentActivity(supabaseAdmin, {
      event: result.status === 'pending' ? 'payment_verify_pending' : 'payment_verify_completed',
      reference: lookupReference || result.reference,
      userId: userResolution.userId,
      targetId: lookupReference || result.reference || customerEmail,
      statusCode: result.status === 'pending' ? 202 : 200,
      message: result.message,
      payload: {
        customerEmail,
        customerId,
        receiverAccountNumber,
        amountNGN,
        credits,
        createdAfter,
        result,
      },
    });

    if (result.status === 'pending') {
      return res.status(202).json(result);
    }

    return res.json(result);
  } catch (error) {
    console.error('[api/verify-payment] unexpected error:', error);
    logError('paymentpoint-verify-payment-unexpected-error', error, {
      scope: 'root-api',
      reference: lookupReference,
      customerEmail,
      userId,
    });
    await logPaymentActivity(supabaseAdmin, {
      event: 'payment_verify_unexpected_error',
      severity: 'error',
      reference: lookupReference,
      userId,
      targetId: lookupReference || customerEmail,
      statusCode: 500,
      message: error?.message || 'Internal server error',
      payload: { customerEmail, customerId, receiverAccountNumber, amountNGN, credits, createdAfter },
    });
    return res.status(500).json({ status: 'failed', message: 'Internal server error' });
  }
}

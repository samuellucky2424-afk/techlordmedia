// @ts-nocheck
import { supabaseAdmin } from './supabase.js';
import {
  createPaymentPointVirtualAccount,
  resolvePaymentPointVirtualAccountConfig,
} from '../shared/paymentpoint-virtual-account.js';
import { logPaymentActivity } from '../shared/payment-activity-log.js';
import { logError, logPayment, summarizeResponseBody } from '../shared/server-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const config = resolvePaymentPointVirtualAccountConfig(process.env);
  if (config.configError) {
    await logPaymentActivity(supabaseAdmin, {
      event: 'paymentpoint_virtual_account_config_error',
      severity: 'error',
      statusCode: 503,
      message: config.configError,
    });
    return res.status(503).json({
      status: 'failed',
      message: config.configError,
    });
  }

  const {
    email,
    name,
    phoneNumber,
    bankCodes,
    credits,
    amountNGN,
  } = req.body || {};

  if (!email || !name || !phoneNumber) {
    await logPaymentActivity(supabaseAdmin, {
      event: 'paymentpoint_virtual_account_rejected_missing_data',
      severity: 'warning',
      statusCode: 400,
      message: 'email, name, and phoneNumber are required',
      payload: { customerEmail: email, customerName: name, hasPhoneNumber: Boolean(phoneNumber), credits, amountNGN },
    });
    return res.status(400).json({
      status: 'failed',
      message: 'email, name, and phoneNumber are required',
    });
  }

  logPayment({
    event: 'paymentpoint-create-virtual-account-request',
    scope: 'root-api',
    customerEmail: email,
    customerName: name,
    phoneNumber,
    credits,
    amountNGN,
    bankCodes: Array.isArray(bankCodes) && bankCodes.length > 0 ? bankCodes : config.bankCodes,
  });
  await logPaymentActivity(supabaseAdmin, {
    event: 'paymentpoint_virtual_account_request',
    targetId: email,
    payload: {
      customerEmail: email,
      customerName: name,
      hasPhoneNumber: Boolean(phoneNumber),
      credits,
      amountNGN,
      bankCodes: Array.isArray(bankCodes) && bankCodes.length > 0 ? bankCodes : config.bankCodes,
    },
  });

  try {
    const result = await createPaymentPointVirtualAccount({
      email,
      name,
      phoneNumber,
      bankCodes: Array.isArray(bankCodes) && bankCodes.length > 0 ? bankCodes : config.bankCodes,
      apiKey: config.apiKey,
      secretKey: config.secretKey,
      businessId: config.businessId,
    });

    await logPaymentActivity(supabaseAdmin, {
      event: result.reused === true ? 'paymentpoint_virtual_account_reused' : 'paymentpoint_virtual_account_created',
      targetId: email,
      message: result.message || 'Virtual account ready',
      payload: {
        customerEmail: email,
        credits,
        amountNGN,
        reused: result.reused === true,
        cachedAt: result.cachedAt || null,
        bankAccountCount: Array.isArray(result.bankAccounts) ? result.bankAccounts.length : 0,
        customerId: result.customer?.customer_id,
      },
    });

    return res.json({
      status: 'success',
      message: result.message || 'Virtual account created successfully',
      reused: result.reused === true,
      cachedAt: result.cachedAt || null,
      credits,
      amountNGN,
      customer: result.customer,
      business: result.business,
      bankAccounts: result.bankAccounts,
      errors: result.errors,
    });
  } catch (error) {
    console.error('[api/create-virtual-account] PaymentPoint request failed:', error?.responseBody || error);
    logError('paymentpoint-create-virtual-account-failed', error, {
      scope: 'root-api',
      customerEmail: email,
      customerName: name,
      phoneNumber,
      credits,
      amountNGN,
      responseBody: summarizeResponseBody(error?.responseBody),
    });
    logPayment({
      event: 'paymentpoint-create-virtual-account-failed',
      scope: 'root-api',
      customerEmail: email,
      message: error?.message || 'Unable to create PaymentPoint virtual account',
      responseBody: summarizeResponseBody(error?.responseBody),
    });
    await logPaymentActivity(supabaseAdmin, {
      event: 'paymentpoint_virtual_account_failed',
      severity: 'error',
      targetId: email,
      statusCode: error?.statusCode || 502,
      message: error?.message || 'Unable to create PaymentPoint virtual account',
      payload: {
        customerEmail: email,
        customerName: name,
        hasPhoneNumber: Boolean(phoneNumber),
        credits,
        amountNGN,
        responseBody: summarizeResponseBody(error?.responseBody),
      },
    });
    return res.status(error?.statusCode || 502).json({
      status: 'failed',
      message: error?.message || 'Unable to create PaymentPoint virtual account',
      errors: Array.isArray(error?.responseBody?.errors) ? error.responseBody.errors : [],
    });
  }
}

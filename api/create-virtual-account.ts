// @ts-nocheck
import {
  createPaymentPointVirtualAccount,
  resolvePaymentPointVirtualAccountConfig,
} from '../shared/paymentpoint-virtual-account.js';
import { logError, logPayment, summarizeResponseBody } from '../shared/server-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const config = resolvePaymentPointVirtualAccountConfig(process.env);
  if (config.configError) {
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
    return res.status(error?.statusCode || 502).json({
      status: 'failed',
      message: error?.message || 'Unable to create PaymentPoint virtual account',
      errors: Array.isArray(error?.responseBody?.errors) ? error.responseBody.errors : [],
    });
  }
}
// @ts-nocheck
import { logPaymentActivity } from './payment-activity-log.js';

const PAYMENTPOINT_CREDIT_PLANS = [
  { credits: 500, amountNGN: 11500 },
  { credits: 1000, amountNGN: 23000 },
  { credits: 2000, amountNGN: 46000 },
  { credits: 5000, amountNGN: 115000 },
];

const PAYMENTPOINT_NAIRA_PER_CREDIT = PAYMENTPOINT_CREDIT_PLANS[0].amountNGN / PAYMENTPOINT_CREDIT_PLANS[0].credits;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function getWalletCredits(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('wallets')
    .select('credits')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Number(data?.credits || 0);
}

async function upsertWalletCredits(supabaseAdmin, userId, credits) {
  const { error } = await supabaseAdmin
    .from('wallets')
    .upsert({ user_id: userId, credits }, { onConflict: 'user_id' });

  if (error) {
    throw error;
  }

  return credits;
}

async function insertFirstSuccessfulTransaction(supabaseAdmin, payloads) {
  let lastError = null;

  for (const payload of payloads) {
    const { error } = await supabaseAdmin.from('transactions').insert(payload);
    if (!error) {
      return;
    }

    lastError = error;
  }

  throw lastError;
}

async function insertSubscriptionRecord(supabaseAdmin, payloads) {
  for (const payload of payloads) {
    const { error } = await supabaseAdmin.from('subscriptions').insert(payload);
    if (!error) {
      return;
    }
  }
}

export function getPaymentPointCreditsForAmount(amountPaidNGN, requestedCredits = null) {
  const normalizedRequestedCredits = toFiniteNumber(requestedCredits);
  if (normalizedRequestedCredits && normalizedRequestedCredits > 0) {
    return Math.round(normalizedRequestedCredits);
  }

  const normalizedAmount = toFiniteNumber(amountPaidNGN);
  if (!(normalizedAmount > 0)) {
    return 0;
  }

  const matchedPlan = PAYMENTPOINT_CREDIT_PLANS.find((plan) => amountsMatch(plan.amountNGN, normalizedAmount));
  if (matchedPlan) {
    return matchedPlan.credits;
  }

  return Math.max(1, Math.round(normalizedAmount / PAYMENTPOINT_NAIRA_PER_CREDIT));
}

export function extractPaymentPointPaymentContext(payload, fallback = {}) {
  const metadata = payload?.metadata && typeof payload.metadata === 'object'
    ? payload.metadata
    : (payload?.meta && typeof payload.meta === 'object' ? payload.meta : {});

  return {
    reference: normalizeString(payload?.transaction_id || fallback.reference || fallback.transactionId),
    transactionId: normalizeString(payload?.transaction_id || fallback.transactionId),
    amountPaidNGN: toFiniteNumber(payload?.amount_paid ?? fallback.amountPaidNGN) || 0,
    settlementAmountNGN: toFiniteNumber(payload?.settlement_amount),
    settlementFeeNGN: toFiniteNumber(payload?.settlement_fee),
    credits: getPaymentPointCreditsForAmount(
      payload?.amount_paid ?? fallback.amountPaidNGN,
      metadata?.credits ?? fallback.credits,
    ),
    notificationStatus: String(payload?.notification_status || '').toLowerCase(),
    transactionStatus: String(payload?.transaction_status || '').toLowerCase(),
    description: normalizeString(payload?.description || fallback.description),
    customer: payload?.customer && typeof payload.customer === 'object' ? payload.customer : {},
  };
}

export function validatePaymentPointNotification(payload) {
  const context = extractPaymentPointPaymentContext(payload);

  if (context.notificationStatus && context.notificationStatus !== 'payment_successful') {
    return { ok: false, ignore: true, message: 'Ignoring non-success PaymentPoint notification' };
  }

  if (context.transactionStatus && !['success', 'successful', 'succeeded'].includes(context.transactionStatus)) {
    return { ok: false, ignore: true, message: 'Ignoring non-success PaymentPoint transaction' };
  }

  if (!context.reference) {
    return { ok: false, message: 'Missing transaction_id' };
  }

  if (!(context.amountPaidNGN > 0)) {
    return { ok: false, message: 'Invalid amount_paid' };
  }

  return { ok: true, context };
}

export async function resolvePaymentPointUserId(supabaseAdmin, customer = {}, fallbackUserId = null) {
  const explicitUserId = normalizeString(fallbackUserId);
  if (explicitUserId && UUID_PATTERN.test(explicitUserId)) {
    return { userId: explicitUserId, customerEmail: normalizeEmail(customer?.email), source: 'explicit' };
  }

  const customerId = normalizeString(customer?.customer_id);
  if (customerId && UUID_PATTERN.test(customerId)) {
    return { userId: customerId, customerEmail: normalizeEmail(customer?.email), source: 'customer_id' };
  }

  const customerEmail = normalizeEmail(customer?.email);
  if (!customerEmail || !supabaseAdmin) {
    return { userId: null, customerEmail, source: 'email' };
  }

  {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', customerEmail)
      .maybeSingle();

    if (!error && data?.id) {
      return { userId: data.id, customerEmail, source: 'email' };
    }
  }

  {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id')
      .ilike('email', customerEmail)
      .maybeSingle();

    if (!error && data?.id) {
      return { userId: data.id, customerEmail, source: 'email' };
    }

    return { userId: null, customerEmail, source: 'email', error };
  }
}

export async function applyVerifiedPayment(supabaseAdmin, {
  reference,
  userId,
  credits,
  amountPaidNGN,
  description = null,
  provider = 'PaymentPoint',
}) {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client is unavailable');
  }

  if (!reference || !userId) {
    throw new Error('Missing payment reference or userId');
  }

  await logPaymentActivity(supabaseAdmin, {
    event: 'payment_apply_started',
    reference,
    userId,
    targetId: reference,
    payload: { requestedCredits: credits, amountPaidNGN, provider },
  });

  const { data: existingTransaction, error: existingTransactionError } = await supabaseAdmin
    .from('transactions')
    .select('id, credits')
    .eq('user_id', userId)
    .eq('reference', reference)
    .maybeSingle();

  if (existingTransactionError) {
    throw existingTransactionError;
  }

  if (existingTransaction) {
    const newCredits = await getWalletCredits(supabaseAdmin, userId);
    await logPaymentActivity(supabaseAdmin, {
      event: 'payment_apply_duplicate_skipped',
      reference,
      userId,
      targetId: reference,
      message: 'Payment already processed',
      payload: {
        existingTransactionId: existingTransaction.id,
        existingCredits: existingTransaction.credits,
        newCredits,
      },
    });

    return {
      status: 'success',
      message: 'Payment already processed',
      creditsAdded: 0,
      newCredits,
      reference,
    };
  }

  const creditsToAdd = getPaymentPointCreditsForAmount(amountPaidNGN, credits);
  if (!(creditsToAdd > 0)) {
    throw new Error('Unable to derive credits for this payment');
  }

  const currentCredits = await getWalletCredits(supabaseAdmin, userId);
  const newCredits = currentCredits + creditsToAdd;
  await upsertWalletCredits(supabaseAdmin, userId, newCredits);

  await logPaymentActivity(supabaseAdmin, {
    event: 'wallet_credits_added',
    reference,
    userId,
    targetId: reference,
    message: `${creditsToAdd} credits added`,
    payload: {
      beforeCredits: currentCredits,
      creditsAdded: creditsToAdd,
      afterCredits: newCredits,
      amountPaidNGN,
      provider,
    },
  });

  const timestamp = new Date().toISOString();
  const planName = `${creditsToAdd} Credits`;
  const transactionDescription = description || `${provider} credit purchase`;

  await insertFirstSuccessfulTransaction(supabaseAdmin, [
    {
      user_id: userId,
      type: 'credit',
      amount: amountPaidNGN,
      credits: creditsToAdd,
      reference,
      description: transactionDescription,
      status: 'success',
      created_at: timestamp,
    },
    {
      user_id: userId,
      type: 'credit',
      amount: amountPaidNGN,
      credits: creditsToAdd,
      reference,
      description: transactionDescription,
      created_at: timestamp,
    },
    {
      user_id: userId,
      type: 'credit_purchase',
      amount_naira: amountPaidNGN,
      credits: creditsToAdd,
      reference,
      description: transactionDescription,
      created_at: timestamp,
    },
  ]);

  await logPaymentActivity(supabaseAdmin, {
    event: 'payment_transaction_recorded',
    reference,
    userId,
    targetId: reference,
    payload: {
      creditsAdded: creditsToAdd,
      amountPaidNGN,
      description: transactionDescription,
    },
  });

  await insertSubscriptionRecord(supabaseAdmin, [
    {
      user_id: userId,
      plan_name: planName,
      amount_paid: amountPaidNGN,
      credits: creditsToAdd,
      status: 'active',
      created_at: timestamp,
    },
    {
      user_id: userId,
      plan_name: planName,
      amount_paid: amountPaidNGN,
      credits: creditsToAdd,
      created_at: timestamp,
    },
  ]);

  await logPaymentActivity(supabaseAdmin, {
    event: 'payment_apply_completed',
    reference,
    userId,
    targetId: reference,
    message: 'PaymentPoint payment processed successfully',
    payload: {
      creditsAdded: creditsToAdd,
      newCredits,
      amountPaidNGN,
      provider,
    },
  });

  return {
    status: 'success',
    message: 'PaymentPoint payment processed successfully',
    creditsAdded: creditsToAdd,
    newCredits,
    reference,
  };
}

export async function getProcessedPaymentStatus(supabaseAdmin, { reference, userId }) {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client is unavailable');
  }

  if (!reference || !userId) {
    return {
      status: 'pending',
      message: 'PaymentPoint confirmation is still pending',
      reference,
    };
  }

  const { data: transaction, error: transactionError } = await supabaseAdmin
    .from('transactions')
    .select('id, credits, reference, description, created_at')
    .eq('user_id', userId)
    .eq('reference', reference)
    .maybeSingle();

  if (transactionError) {
    throw transactionError;
  }

  if (!transaction) {
    return {
      status: 'pending',
      message: 'Waiting for PaymentPoint webhook confirmation',
      reference,
    };
  }

  return {
    status: 'success',
    message: 'PaymentPoint payment already processed',
    reference: transaction.reference || reference,
    creditsAdded: Number(transaction.credits || 0),
    newCredits: await getWalletCredits(supabaseAdmin, userId),
  };
}

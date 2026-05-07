// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import { logPaymentActivity } from '../shared/payment-activity-log.js';

const CREDITS_PER_SECOND = 2;
// Hard ceiling: one session can never bill more than 2 hours,
// protecting users whose app crashed and left an orphaned session.
const MAX_BILLABLE_SECONDS = 7200;

function normalizeCredits(value) {
  const credits = Number(value ?? 0);
  return Number.isFinite(credits) ? credits : 0;
}

function getBillableSeconds(startTime) {
  const timestamp = new Date(startTime).getTime();
  if (!Number.isFinite(timestamp)) {
    return 0;
  }

  const elapsedSeconds = Math.floor((Date.now() - timestamp) / 1000);
  return Math.min(Math.max(elapsedSeconds, 0), MAX_BILLABLE_SECONDS);
}

// Bills the exact seconds streamed (start_time → now), capped at max_seconds.
async function billAndCloseSession(session, userId) {
  const { data: walletData, error: walletError } = await supabaseAdmin
    .from('wallets').select('credits').eq('user_id', userId).maybeSingle();

  if (walletError) {
    throw walletError;
  }

  const currentCredits = normalizeCredits(walletData?.credits);

  const billableSeconds = getBillableSeconds(session.start_time);
  const creditsToDeduct = Math.min(currentCredits, billableSeconds * CREDITS_PER_SECOND);
  const newCredits = currentCredits - creditsToDeduct;

  const updateResults = await Promise.all([
    supabaseAdmin
      .from('sessions')
      .update({
        end_time: new Date(),
        status: 'ended',
        seconds_used: billableSeconds,
        cost: creditsToDeduct,
      })
      .eq('id', session.id)
      .eq('status', 'active'),
    creditsToDeduct > 0
      ? supabaseAdmin.from('wallets').update({ credits: newCredits }).eq('user_id', userId)
      : Promise.resolve(),
  ]);

  const updateError = updateResults.find(result => result?.error);
  if (updateError?.error) {
    throw updateError.error;
  }

  await logPaymentActivity(supabaseAdmin, {
    event: 'wallet_credits_deducted_session_end',
    userId,
    targetId: session.id,
    message: `${creditsToDeduct} credits deducted at session end`,
    payload: {
      sessionId: session.id,
      beforeCredits: currentCredits,
      creditsDeducted: creditsToDeduct,
      afterCredits: newCredits,
      billableSeconds,
    },
  });

  return newCredits;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ success: false, message: supabaseAdminConfigError || 'Supabase admin is not configured' });
    }

    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'User ID is required' });

    await logPaymentActivity(supabaseAdmin, {
      event: 'session_end_requested',
      userId,
      targetId: userId,
    });

    const { data: activeSession, error: activeSessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, start_time')
      .eq('user_id', userId).eq('status', 'active')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();

    if (activeSessionError) {
      console.error('Failed to load active session:', activeSessionError);
      await logPaymentActivity(supabaseAdmin, {
        event: 'session_end_failed_load_active_session',
        severity: 'error',
        userId,
        targetId: userId,
        message: activeSessionError.message,
      });
      return res.status(500).json({ success: false, message: 'Failed to load active session' });
    }

    if (!activeSession) {
      await logPaymentActivity(supabaseAdmin, {
        event: 'session_end_no_active_session',
        userId,
        targetId: userId,
      });
      return res.json({ success: true, message: 'No active session', remainingCredits: null });
    }

    const remainingCredits = await billAndCloseSession(activeSession, userId);
    await logPaymentActivity(supabaseAdmin, {
      event: 'session_ended',
      userId,
      targetId: activeSession.id,
      payload: { sessionId: activeSession.id, remainingCredits },
    });
    return res.json({ success: true, remainingCredits });
  } catch (error) {
    console.error('end-session unexpected error:', error);
    await logPaymentActivity(supabaseAdmin, {
      event: 'session_end_unexpected_error',
      severity: 'error',
      message: error?.message || 'Internal server error',
    });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

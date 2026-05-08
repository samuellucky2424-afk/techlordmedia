// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import { logPaymentActivity } from '../shared/payment-activity-log.js';

const CREDITS_PER_SECOND = 2;
const MAX_BILLABLE_SECONDS = 7200;
const SESSION_BILLING_GRACE_SECONDS = 20;

function getDecartApiKey() {
  return process.env.DECART_API_KEY?.trim() || null;
}

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
  const billableSeconds = Math.max(elapsedSeconds - SESSION_BILLING_GRACE_SECONDS, 0);
  return Math.min(billableSeconds, MAX_BILLABLE_SECONDS);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ allowed: false, error: supabaseAdminConfigError || 'Supabase admin is not configured' });
    }

    const decartApiKey = getDecartApiKey();
    if (!decartApiKey) {
      return res.status(503).json({ allowed: false, error: 'Missing DECART_API_KEY in server environment' });
    }

    const { userId } = req.body;
    if (!userId) return res.status(400).json({ allowed: false, error: 'User ID is required' });

    await logPaymentActivity(supabaseAdmin, {
      event: 'session_start_requested',
      userId,
      targetId: userId,
      payload: {},
    });

    // Fetch orphaned sessions and wallet in parallel
    const [activeSessionsResult, walletResult] = await Promise.all([
      supabaseAdmin
        .from('sessions')
        .select('id, start_time')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('start_time', { ascending: true }),
      supabaseAdmin.from('wallets').select('credits').eq('user_id', userId).maybeSingle(),
    ]);

    if (activeSessionsResult.error) {
      console.error('Failed to load active sessions:', activeSessionsResult.error);
      return res.status(500).json({ allowed: false, error: 'Failed to load active sessions' });
    }

    if (walletResult.error) {
      console.error('Failed to load wallet:', walletResult.error);
      return res.status(500).json({ allowed: false, error: 'Failed to load wallet' });
    }

    const existingActiveSessions = activeSessionsResult.data ?? [];
    const walletNow = walletResult.data;

    let runningCredits = normalizeCredits(walletNow?.credits);
    if (existingActiveSessions && existingActiveSessions.length > 0) {
      const cleanupResults = await Promise.all(
        existingActiveSessions.map((session) =>
          supabaseAdmin.from('sessions')
            .update({
              end_time: new Date(),
              status: 'ended',
              seconds_used: 0,
              credits_used: 0,
            })
            .eq('id', session.id)
            .eq('status', 'active'),
        ),
      );

      const cleanupError = cleanupResults.find(result => result?.error);
      if (cleanupError?.error) {
        console.error('Failed to close orphaned sessions:', cleanupError.error);
        await logPaymentActivity(supabaseAdmin, {
          event: 'orphan_session_cleanup_failed',
          severity: 'error',
          userId,
          targetId: userId,
          message: cleanupError.error.message,
          payload: { activeSessionCount: existingActiveSessions.length },
        });
        return res.status(500).json({ allowed: false, error: 'Failed to close previous sessions' });
      }

      await logPaymentActivity(supabaseAdmin, {
        event: 'orphan_sessions_closed_without_charge',
        userId,
        targetId: userId,
        message: 'Previous active sessions were closed without charging during a new explicit start',
        payload: {
          activeSessionCount: existingActiveSessions.length,
          sessionIds: existingActiveSessions.map((session) => session.id),
        },
      });
    }

    // Use the already-fetched (and post-billing-adjusted) credit balance
    const userCredits = runningCredits;
    if (userCredits <= 0) {
      await logPaymentActivity(supabaseAdmin, {
        event: 'session_start_denied_insufficient_credits',
        severity: 'warning',
        userId,
        targetId: userId,
        payload: { credits: userCredits },
      });
      return res.json({ allowed: false, error: 'Insufficient credits' });
    }

    // Expose a deterministic time budget to the client based on current credits.
    const maxSeconds = Math.floor(userCredits / CREDITS_PER_SECOND) + SESSION_BILLING_GRACE_SECONDS;

    const { data: newSession, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert({
        user_id: userId,
        status: 'active',
        start_time: new Date(),
        credits_used: 0,
        seconds_used: 0,
      }).select('id').single();

    if (sessionError) {
      console.error('Failed to create session:', sessionError);
      await logPaymentActivity(supabaseAdmin, {
        event: 'session_start_failed',
        severity: 'error',
        userId,
        targetId: userId,
        message: sessionError.message,
        payload: { credits: userCredits },
      });
      return res.status(500).json({ allowed: false, error: 'Failed to create session' });
    }

    await logPaymentActivity(supabaseAdmin, {
      event: 'session_started',
      userId,
      targetId: newSession.id,
      payload: { sessionId: newSession.id, credits: userCredits, maxSeconds },
    });

    res.json({ allowed: true, sessionId: newSession.id, credits: userCredits, maxSeconds, token: decartApiKey });
  } catch (error) {
    console.error('start-session unexpected error:', error);
    await logPaymentActivity(supabaseAdmin, {
      event: 'session_start_unexpected_error',
      severity: 'error',
      message: error?.message || 'Internal server error',
    });
    res.status(500).json({ allowed: false, error: 'Internal server error' });
  }
}

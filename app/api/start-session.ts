// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';

const CREDITS_PER_SECOND = 2;
const MAX_BILLABLE_SECONDS = 7200;

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
  return Math.min(Math.max(elapsedSeconds, 0), MAX_BILLABLE_SECONDS);
}

function buildOrphanSessionChargePlan(sessions, availableCredits) {
  let remainingCredits = Math.max(0, normalizeCredits(availableCredits));

  const plannedSessions = sessions.map((session) => {
    const billableSeconds = getBillableSeconds(session.start_time);
    const requestedCredits = billableSeconds * CREDITS_PER_SECOND;
    const chargedCredits = Math.min(remainingCredits, requestedCredits);
    remainingCredits -= chargedCredits;

    return {
      id: session.id,
      billableSeconds,
      chargedCredits,
    };
  });

  return {
    plannedSessions,
    remainingCredits,
  };
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

    // Bill and close all orphaned sessions in one parallel batch.
    // Charge allocation is capped by current wallet credits so each session record
    // reflects the actual deducted amount.
    let runningCredits = normalizeCredits(walletNow?.credits);
    if (existingActiveSessions && existingActiveSessions.length > 0) {
      const { plannedSessions, remainingCredits } = buildOrphanSessionChargePlan(
        existingActiveSessions,
        runningCredits,
      );
      const actualDeduction = runningCredits - remainingCredits;
      runningCredits = remainingCredits;

      // Close all sessions + update wallet in one parallel round-trip
      const cleanupResults = await Promise.all([
        ...plannedSessions.map((sessionPlan) =>
          supabaseAdmin.from('sessions')
            .update({
              end_time: new Date(),
              status: 'ended',
              seconds_used: sessionPlan.billableSeconds,
              credits_used: sessionPlan.chargedCredits,
            })
            .eq('id', sessionPlan.id)
            .eq('status', 'active'),
        ),
        actualDeduction > 0
          ? supabaseAdmin.from('wallets').update({ credits: runningCredits }).eq('user_id', userId)
          : Promise.resolve(),
      ]);

      const cleanupError = cleanupResults.find(result => result?.error);
      if (cleanupError?.error) {
        console.error('Failed to close orphaned sessions:', cleanupError.error);
        return res.status(500).json({ allowed: false, error: 'Failed to close previous sessions' });
      }
    }

    // Use the already-fetched (and post-billing-adjusted) credit balance
    const userCredits = runningCredits;
    if (userCredits <= 0) {
      return res.json({ allowed: false, error: 'Insufficient credits' });
    }

    // Expose a deterministic time budget to the client based on current credits.
    const maxSeconds = Math.floor(userCredits / CREDITS_PER_SECOND);

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
      return res.status(500).json({ allowed: false, error: 'Failed to create session' });
    }

    res.json({ allowed: true, sessionId: newSession.id, credits: userCredits, maxSeconds, token: decartApiKey });
  } catch (error) {
    console.error('start-session unexpected error:', error);
    res.status(500).json({ allowed: false, error: 'Internal server error' });
  }
}

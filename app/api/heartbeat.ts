// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';

const CREDITS_PER_SECOND = 2;
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ error: supabaseAdminConfigError });

  const { userId, sessionId } = req.body;
  if (!userId || !sessionId) {
    return res.status(400).json({ error: 'userId and sessionId are required' });
  }

  try {
    const [{ data: walletData }, { data: sessionData }] = await Promise.all([
      supabaseAdmin.from('wallets').select('credits').eq('user_id', userId).single(),
      supabaseAdmin
        .from('sessions')
        .select('id, start_time, status')
        .eq('id', sessionId)
        .eq('user_id', userId)
        .eq('status', 'active')
        .single(),
    ]);

    if (!sessionData) {
      return res.json({ shouldStop: true, reason: 'session_not_found', remainingCredits: 0 });
    }

    const currentCredits = normalizeCredits(walletData?.credits);

    if (currentCredits <= 0) {
      return res.json({ shouldStop: true, reason: 'no_credits', remainingCredits: 0 });
    }

    const billableElapsed = getBillableSeconds(sessionData.start_time);
    const liveDeducted = Math.min(currentCredits, billableElapsed * CREDITS_PER_SECOND);
    const remainingCredits = Math.max(0, currentCredits - liveDeducted);
    const shouldStop = remainingCredits <= 0;

    return res.json({
      remainingCredits,
      elapsedSeconds: billableElapsed,
      shouldStop,
      forceEnd: shouldStop,
    });
  } catch (error) {
    console.error('Heartbeat error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

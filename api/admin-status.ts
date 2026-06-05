// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';

function getBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!supabaseAdmin) {
    return res.status(503).json({
      isAdmin: false,
      warning: supabaseAdminConfigError || 'Supabase admin is not configured',
    });
  }

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ isAdmin: false, error: 'Missing bearer token' });
  }

  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authData?.user?.id) {
      return res.status(401).json({
        isAdmin: false,
        error: authError?.message || 'Invalid bearer token',
      });
    }

    const user = authData.user;
    const { data: adminRow, error: adminError } = await supabaseAdmin
      .from('admins')
      .select('user_id,email')
      .eq('user_id', user.id)
      .maybeSingle();

    if (adminError) {
      console.error('[api/admin-status] admin lookup failed:', adminError);
      return res.status(500).json({ isAdmin: false, error: adminError.message || 'admin lookup failed' });
    }

    if (!adminRow?.user_id && user.email) {
      const { data: adminEmailRow, error: adminEmailError } = await supabaseAdmin
        .from('admins')
        .select('user_id,email')
        .eq('email', user.email)
        .maybeSingle();

      if (adminEmailError) {
        console.error('[api/admin-status] admin email lookup failed:', adminEmailError);
        return res.status(500).json({ isAdmin: false, error: adminEmailError.message || 'admin email lookup failed' });
      }

      if (adminEmailRow?.user_id) {
        return res.json({
          isAdmin: true,
          userId: user.id,
          email: user.email || null,
        });
      }
    }

    return res.json({
      isAdmin: Boolean(adminRow?.user_id),
      userId: user.id,
      email: user.email || null,
    });
  } catch (error) {
    console.error('[api/admin-status] unexpected error:', error);
    return res.status(500).json({ isAdmin: false, error: 'Internal server error' });
  }
}

// @ts-nocheck
import { createClient } from '@supabase/supabase-js';

import { createLoggedSupabaseClient } from '../shared/logged-supabase-client.js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabaseAdminConfigError = !supabaseUrl
  ? 'Missing SUPABASE_URL or VITE_SUPABASE_URL'
  : !supabaseServiceKey
    ? 'Missing SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY'
    : null;

const rawSupabaseAdmin = (supabaseUrl && supabaseServiceKey)
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null;

export const supabaseAdmin = rawSupabaseAdmin
  ? createLoggedSupabaseClient(rawSupabaseAdmin, 'root-api')
  : null;

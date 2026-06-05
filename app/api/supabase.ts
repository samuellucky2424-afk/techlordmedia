// @ts-nocheck
import { createClient } from '@supabase/supabase-js';

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

const TABLE_NAMES = {
  users: 'kusers',
  wallets: 'kwallets',
  transactions: 'ktransactions',
  sessions: 'ksessions',
  plans: 'kplans',
  subscriptions: 'ksubscriptions',
  exchange_rates: 'kexchange_rates',
  admins: 'kadmins',
  credit_adjustments: 'kcredit_adjustments',
  audit_log: 'kaudit_log',
};

const RPC_NAMES = {
  get_user_credits: 'kget_user_credits',
  deduct_credits: 'kdeduct_credits',
  add_credits: 'kadd_credits',
  is_admin: 'kis_admin',
  is_current_user_admin: 'kis_current_user_admin',
  admin_list_users: 'kadmin_list_users',
  admin_set_credits: 'kadmin_set_credits',
  admin_set_blocked: 'kadmin_set_blocked',
  admin_upsert_plan: 'kadmin_upsert_plan',
  admin_delete_plan: 'kadmin_delete_plan',
  admin_stats: 'kadmin_stats',
};

function createMappedSupabaseClient(client) {
  if (!client) return null;

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table) => target.from(TABLE_NAMES[table] || table);
      }

      if (prop === 'rpc') {
        return (fn, args, options) => target.rpc(RPC_NAMES[fn] || fn, args, options);
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

export const supabaseAdmin = rawSupabaseAdmin
  ? createMappedSupabaseClient(rawSupabaseAdmin)
  : null;

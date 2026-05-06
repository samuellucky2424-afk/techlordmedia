import { createClient } from '@supabase/supabase-js';

const DEPLOYED_SUPABASE_URL = 'https://zrtvliudyefmeeltxoaz.supabase.co';
const DEPLOYED_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpydHZsaXVkeWVmbWVlbHR4b2F6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTA4MjEsImV4cCI6MjA4ODM4NjgyMX0.wlLOoTx8DN96a1qU5KMhP0bhFeC_y3K6JqrFQqODOFY';

function resolvePublicConfig(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith('YOUR_')) {
    return fallback;
  }

  return trimmed;
}

const supabaseUrl = resolvePublicConfig(import.meta.env.VITE_SUPABASE_URL, DEPLOYED_SUPABASE_URL);
const supabaseAnonKey = resolvePublicConfig(import.meta.env.VITE_SUPABASE_ANON_KEY, DEPLOYED_SUPABASE_ANON_KEY);

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

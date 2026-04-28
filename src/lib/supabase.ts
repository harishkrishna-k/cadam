import { createClient } from '@supabase/supabase-js';
import { Database } from '@shared/database';

const rawSupabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const rawSupabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

console.log('CADAM: Supabase env check', { url: rawSupabaseUrl ? 'SET' : 'NOT SET', key: rawSupabaseKey ? 'SET' : 'NOT SET' });

// Check if real Supabase config is missing
export const isSupabaseConfigMissing = !rawSupabaseUrl || !rawSupabaseKey;

// Fallback values keep the client constructable so imports don't throw
// when env vars are missing. The app should gate on isSupabaseConfigMissing
// and avoid making real requests in this state.
const supabaseUrl = rawSupabaseUrl || 'https://example.supabase.co';
const supabaseKey = rawSupabaseKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy';

export const supabase = createClient<Database>(supabaseUrl, supabaseKey);

/* ============================================================
   Paper Tracker — Shared Configuration
   ============================================================
   ⚠️  SECURITY NOTE: 
   anon key อยู่ที่นี่แบบ client-side (browser เห็นได้)
   การป้องกันพึ่งพา Supabase RLS (Row Level Security) เท่านั้น
   
   ถ้าต้องการความปลอดภัยสูงกว่านี้ ให้ไปต่อ Step 2 (Next.js)
   ซึ่งจะย้าย key ไปอยู่ server-side env variable
   ============================================================ */

export const SUPABASE_URL = 'https://lfrwghrlxaordpxrqyij.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmcndnaHJseGFvcmRweHJxeWlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MzQ5MjgsImV4cCI6MjA5MjQxMDkyOH0.M13hI5TUqEL8iVmGM3pWcjbyULSx_n7VPgI2TcHnNZA';

// Supabase client - shared instance ใช้ได้ทั้ง 2 หน้า
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

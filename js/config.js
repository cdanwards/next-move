// Cloud accounts are optional. Leave these empty and the app runs local-only:
// no login, and everything stays in the browser.
//
// To turn on invite-only accounts, create a Supabase project (see README.md) and paste in
// its Project URL and anon/publishable key. The anon key is meant to be public: row-level
// security in supabase/migrations is what keeps each person's data private.

export const SUPABASE_URL = 'https://wncojuifyehtgflruvlt.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InduY29qdWlmeWVodGdmbHJ1dmx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0NjY3MzUsImV4cCI6MjEwNzA0MjczNX0.U_3rWfOQpque-KVvaat1ucHb0i4CSkhT_aU4W9LyD_g';

// Shown on the sign-in screen so people know who to ask for an invite.
export const INVITE_CONTACT = 'Dan';

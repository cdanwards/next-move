// Cloud accounts are optional. Leave these empty and the app runs local-only:
// no login, and everything stays in the browser.
//
// To turn on invite-only accounts, create a Supabase project (see README.md) and paste in
// its Project URL and anon/publishable key. The anon key is meant to be public: row-level
// security in supabase/migrations is what keeps each person's data private.

export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';

// Shown on the sign-in screen so people know who to ask for an invite.
export const INVITE_CONTACT = 'Dan';

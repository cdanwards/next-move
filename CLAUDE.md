# Instructions for Claude: next-move

A static job-search tool with optional invite-only accounts (Supabase), hosted on GitHub Pages. Read `README.md` first.

## Who it's for

It started as a tool for one of Dan's friends and is now generalized for anyone Dan invites. Nothing user-specific is in the code: each person's details come from the first-run setup (`#/welcome`).

## Hard rules

- **No build step.** Plain HTML, CSS, and ES modules. The Supabase SDK is a pinned CDN import in `cloud.js`. Don't add npm, bundlers, or frameworks unless Dan asks.
- **Local-only must keep working.** With `js/config.js` empty, there's no login and no network use beyond fonts and ATS reads. Test both modes when you touch boot, store, or docs.
- **`js/config.js` holds the production project** (`wncojuifyehtgflruvlt`, Dan's personal Supabase org) and its anon key. That key is public by design; RLS protects the data. Never commit the local stack's URL or key, and never put a `service_role` or `sb_secret_` key anywhere in the repo. For local testing, swap in the local values temporarily and restore the production ones before committing.
- **Privacy.** No analytics and no third-party scripts. Outbound requests are limited to:
  - Google Fonts
  - Supabase (the person's own data, when signed in)
  - Greenhouse, Lever, and Ashby public APIs (job URL only)

  Don't add a CORS proxy.
- **The source is public.** No personal details in defaults or packs: no one's employer, salary, or messages.
- **Escape everything rendered.** Views are template strings, so every user value goes through `h()`. URLs go through `safeUrl()`, which allows only http and https.
- **Don't break saved data.** `merge()` in `store.js` layers saved data over `defaults()`, including the nested `profile` and `search` objects. Add new nested settings objects there. Saved data without `onboarded` counts as already set up.

## Accounts & sync (how it works)

- **Boot** (`boot()` in `app.js`):
  1. `cloud.init()` reads any email-link tokens from the URL hash. Clear them afterward with `replaceState`.
  2. `enterWorkspace()` switches the local cache to `nextmove:v1:<userId>`, pulls the cloud row, decides local vs. cloud, then calls `store.setRemote(cloud.pushWorkspace)`.
- **Sync model.** One `workspaces` row per user holds the whole state as JSONB. Saves push after a 1.2s debounce. `meta.dirty` and `meta.remoteAt` live in `localStorage` at `<key>:meta`.
  - **Only compare server timestamps.** A trigger sets `updated_at` to `now()` on every write, and `pushWorkspace` returns that stamp. Client clocks drift (this bit us once).
  - **On focus or visibility, pull** if the server stamp is newer and there are no local unsynced edits. If both changed, `enterWorkspace` asks which version to keep.
- **Auth callbacks.** Defer work in `onAuthStateChange` with `setTimeout`; calling Supabase inside the callback can deadlock.
- **Invite-only setup.** The app calls `signInWithOtp` with `shouldCreateUser: false`, so its UI never creates accounts. Locally, `[auth] enable_signup = false` also blocks API sign-ups. On the live project Dan chose to leave sign-ups **on** (2026-10-08), so accounts can be created by calling the API directly. Don't change that without asking. Keep `[auth.email] enable_signup = true`: in the CLI it toggles the email provider itself ("Email logins are disabled").
- **Invited users.** Until they click the invite link they're unconfirmed, and code sign-in rejects them. The alternative is creating users with auto-confirm.
- **Navigation.** Use `go(hash)` instead of `location.hash =`. Setting the same hash fires no `hashchange`, which once left the setup page stuck.
- **Public routes.** `#/send` stays public so friends can send leads. `#/lead` and `#/import` payloads are saved to `nextmove:returnTo` and restored after sign-in.

## Patterns

- Routing: `routes` map, with `routeFor()` as the guard (login → welcome → page). Each view is `renderX(params) => html string`.
- Events: one delegated `click` handler on `data-act` dispatches to `actions`. `data-bind` inputs autosave. Drawer inputs use `data-job-field`. Don't re-render while someone is typing.
- Files: always go through `docs.js`, never `files.js` or `cloud.js` directly. Views get metadata only; call `docs.getBlob(id)` for the bytes.
- Design: tokens on `:root` with a dark-mode override. Young Serif / Schibsted Grotesk / IBM Plex Mono, safety-orange accent, hard offset shadows. Elements with `.reveal` get a staggered entrance.

## Starter lists (`js/packs.js`)

- Each list has `category` (one of `PACK_CATEGORIES`), `tags`, and companies with short notes (HQ or what they're known for). Keep notes durable; skip a fact rather than guess.
- `rankPacks(profile)` scores lists by how many tags match the person's titles and strengths. Tags of 3 characters or fewer match whole words only, so "ai" doesn't hit "retail". Check a few sample profiles after changing tags.
- No regional lists: the "Biggest employers near …" link in Scout handles location.

## Parsing (`js/parse.js`)

- Every intake path returns `{ title, company, location, workMode, salaryMin, salaryMax, description, url, source, ats }`. `analyze()` suggests ratings only for `direct`, `pay`, `place`, and `build`, and never for `valued`, `growth`, or `new`.
- The bookmarklet (`bookmarkletCode()`) runs on third-party pages. Keep it ES5-ish and dependency-free. It's URI-encoded. Its site selectors go stale; JSON-LD and the user's selection are the dependable parts.
- `extractWins()` keeps a line only if it has a result word and something concrete (a %, $, multiple, count, or award). It skips "Skills:" lines.
- Test regexes against real pasted text, for example `Company · City, ST · 3 days ago`, `$95,000/yr - $120,000/yr`, and `$45 - $50/hr`.

## Verify

- **Local-only:**
  - Run `python3 -m http.server 4317`. In this workspace the preview tool uses the `next-move` entry in `../.claude/launch.json`.
  - With storage cleared you should land on `#/welcome`.
  - Run setup, import a posting, score it, drag the card, upload a file, and do a friend-lead round trip.
- **Accounts:**
  - Run `supabase start` (ports 553xx), point `config.js` at it temporarily, and create a user through the admin API.
  - Sign in with the code from Mailpit (`:55324/api/v1/messages`).
  - Check rows with `docker exec supabase_db_next-move psql -U postgres`.
  - Check RLS with a second user's token.
  - Revert `config.js` when you're done.
- The browser pane may be hidden, so `visibilityState` stays `hidden`. Test the refresh with a `focus` event.
- Check at 375px wide and in both color schemes. Clear storage afterward.

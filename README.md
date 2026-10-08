# Next Move

A job-search field guide. It started as a tool for one friend and now works for anyone you invite. It's a static site (plain HTML, CSS, and ES modules, with no build step) hosted on GitHub Pages. Accounts and sync come from Supabase and are optional.

## What it does

- **First-run setup.** Name, home base, target titles, salary floor, and strengths. Pasting a LinkedIn Experience section or a resume pulls out accomplishments with numbers for the Proof file. Optional starter company lists: 38 industry lists (about 260 employers) in 7 categories, with suggestions that update as the person types their titles and strengths.
- **Scout.** One-click searches on LinkedIn, Indeed, Google Jobs, ZipRecruiter, and Glassdoor with titles, location, salary floor, and recency filled in. **Direct employers** searches only company career sites (Greenhouse, Lever, Workday, Ashby, iCIMS). It also suggests related titles (for marketing, sales, and channel searches) and keeps a target-company list. A starter-list browser ranks industries by the person's profile, and a "Biggest employers near you" link covers the local angle.
- **Import** postings three ways:
  - **Paste a link.** Reads Greenhouse, Lever, and Ashby postings directly through their public APIs.
  - **Clipper bookmarklet.** One click on any job page sends its data over: the page's schema.org `JobPosting` data, the highlighted text, or the description block.
  - **Paste the text.** Works for anything.

  The parser pulls out title, company, location, work setup, and pay (annualizing hourly and monthly rates). It pre-rates the scorecard criteria that a posting can answer, flags the years of experience asked for, and highlights the person's strengths that the posting mentions.
- **Scorecard.** Weighted criteria (direct hire, pay floor, location, ownership, being valued, growth, learning) produce a 0–100 fit score.
- **Board.** Drag-and-drop pipeline: Spotted → Worth a shot → Applied → Talking → Offer → Closed. Each card holds a next step and date, notes, people, the posting text, the files sent, and a timeline.
- **Journal** with Thought, Win, Interview prep, and Idea entries. Wins rotate on the home page as the "Proof file".
- **Files and snippets.** Resume versions, cover letters, and an offer letter, plus reusable answers to copy.
- **Leads from friends.** Anyone can open `#/send?to=Name` (no account needed), fill in a job, and text the link. Opening it drops the job on that person's board.

## Two modes

| | Local-only (default) | Accounts (Supabase) |
|---|---|---|
| Turned on by | `js/config.js` left empty | Project URL and anon key in `js/config.js` |
| Sign-in | None | Email code or magic link; invite-only |
| Where data lives | This browser (`localStorage` + IndexedDB) | Supabase Postgres (one JSON row per person) + private Storage bucket, cached locally |
| Phone + laptop | Manual export/import | Syncs automatically |

In accounts mode, row-level security limits every row and file to its owner. I tested this against a local Supabase stack: a second user sees zero rows, can't download the first user's files, and can't overwrite their workspace. Signed-out visitors read nothing.

## Turn on accounts (one-time, about 20 minutes)

1. **Create a Supabase project** at <https://supabase.com> (the free tier is fine).
2. **Create the tables.** Open the **SQL Editor**, paste in [`supabase/migrations/20261008000000_init.sql`](supabase/migrations/20261008000000_init.sql), and run it. Or use the CLI: `supabase link` then `supabase db push`.
3. **Make it invite-only.** Under **Authentication → Sign In / Providers**, turn **off** "Allow new users to sign up". Leave the Email provider **on**.
4. **Allow the site's URLs.** Under **Authentication → URL Configuration**, set **Site URL** to `https://cdanwards.github.io/next-move/`. Add `https://cdanwards.github.io/next-move/**` and `http://localhost:4317/**` to **Redirect URLs**.
5. **Update the email templates.** Under **Authentication → Emails**, replace **Magic Link** with [`supabase/templates/magic_link.html`](supabase/templates/magic_link.html). It adds the 6-digit code, so people can sign in on a phone without opening the link there. Replace **Invite user** with [`supabase/templates/invite.html`](supabase/templates/invite.html).
6. **Paste in the keys.** Copy the **Project URL** and the **anon / publishable key** (Project Settings → API) into [`js/config.js`](js/config.js), then commit and push. The anon key is meant to be public; row-level security is what protects the data.
7. **Set up email delivery (required).** Supabase's built-in sender only delivers to members of your Supabase team, at 2 emails an hour, so invited friends would never get their code. Under **Authentication → Emails → SMTP Settings**, add your own provider:
   - **If you own a domain:** Resend, Postmark, or Amazon SES. Verify the domain with the provider so mail doesn't land in spam.
   - **If you don't:** Gmail SMTP with an app password (`smtp.gmail.com`, port 587; needs 2-step verification), or Brevo with a single verified sender address. These work, but sign-in emails are more likely to land in spam, so tell people to check.

   With custom SMTP, the limit goes to 30 emails an hour (adjustable under **Authentication → Rate Limits**).
8. **Invite people.** Under **Authentication → Users → Add user**, you have two options:
   - **Send invitation.** They tap the link in the email once. After that they sign in with a code.
   - **Create new user** with **Auto Confirm User** checked. Then send them the site link, and they sign in with a code. No invite email is involved.

**Things to know**
- Free-tier projects pause after about a week with no activity. Daily use keeps it awake; if it does pause, restore it from the dashboard.
- Someone who was invited but never tapped the invite link can't sign in with a code yet. The sign-in screen tells them to tap the link first.

## Run locally

Local-only mode needs nothing but a static server:

```bash
python3 -m http.server 4317
```

To develop against a local Supabase (requires Docker and the Supabase CLI):

```bash
supabase start -x edge-runtime,logflare,vector,imgproxy,supavisor
```

- The stack runs on ports **553xx** (moved off the defaults so it doesn't collide with other local Supabase projects).
- Put `http://127.0.0.1:55321` and the printed anon key in `js/config.js`, but don't commit them.
- Mailpit at <http://127.0.0.1:55324> catches the sign-in emails.
- Create a test user with the CLI's Studio (<http://127.0.0.1:55323>), or with the admin API and the service-role key.

## Deploy to GitHub Pages

```bash
gh repo create next-move --public --source=. --push
```

```bash
gh api -X POST repos/{owner}/next-move/pages -f "source[branch]=main" -f "source[path]=/"
```

`.nojekyll` is included, and the page sets `noindex`.

## Layout

```
index.html            Shell: side rail/nav, view container, drawer, toast
css/styles.css        All styles. Tokens on :root, dark mode via prefers-color-scheme
js/app.js             Boot + auth flow, hash router, all views, drawer, events, sync wiring, backup
js/store.js           State shape and defaults, local cache, sync bookkeeping (dirty/remoteAt), fit score
js/config.js          Supabase URL/key (empty = local-only) and invite contact
js/cloud.js           Supabase client: sign-in, workspace pull/push, document storage
js/docs.js            File API over either IndexedDB (files.js) or Supabase Storage (cloud.js)
js/files.js           IndexedDB storage for local-only mode
js/parse.js           Posting intake (ATS APIs, JSON-LD, text), bookmarklet, fit analysis, win extraction
js/scout.js           Job-board URL builders, related titles, lead encode/decode
js/packs.js           Starter company lists (by category, with tags for ranking)
supabase/             CLI config (invite-only, templates), migration with RLS policies
```

## Routes

`#/brief` · `#/scout` · `#/board` · `#/journal` · `#/files` · `#/setup` · `#/import` · `#/welcome` (first-run setup) · `#/login` · `#/send?to=Name` (public, for friends) · `#/lead?d=…` (incoming lead)

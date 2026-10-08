// Builds pre-filtered search links for the big job boards. No scraping, no APIs:
// each link opens the board's own search with the person's titles and filters applied.

// Related titles for marketing, brand, channel, and sales searches. Shown only when the person's
// titles are in that family (see showAdjacent).
export const ADJACENT_ROLES = [
  { title: 'Partner Marketing Manager', why: 'Channel marketing under the name tech companies use.' },
  { title: 'Channel Program Manager', why: 'Owns the partner program itself: tiers, MDF, incentives.' },
  { title: 'Trade Marketing Manager', why: 'Channel marketing for products sold through retail and distribution.' },
  { title: 'Shopper Marketing Manager', why: 'Programs with retailers like Home Depot, Lowe’s, and Target.' },
  { title: 'Field Marketing Manager', why: 'Regional programs alongside sales. Very visible to leadership.' },
  { title: 'Channel Account Manager', why: 'The sales side of channel. Often pays more because of commission.' },
  { title: 'Product Marketing Manager', why: 'Launches, positioning, and sales tools for a product line.' },
  { title: 'Sales Enablement Manager', why: 'Builds the playbook sales runs. Build it, then hand it off.' },
  { title: 'Ecommerce Marketing Manager', why: 'Owns direct-to-consumer growth: site, conversion, and paid.' },
  { title: 'Business Development Manager', why: 'Sales-focused, and suits someone who learns a new vertical fast.' },
  { title: 'Retail Marketing Manager', why: 'Brand-side programs with retail partners.' },
  { title: 'Category Manager', why: 'Owns a product line’s P&L at a manufacturer or retailer.' },
];

export function showAdjacent(titles) {
  return titles.length === 0 || titles.some((t) => /marketing|brand|channel|partner|sales|business development|trade/i.test(t));
}

const POSTED = {
  day: { label: 'Past 24 hours', linkedin: 'r86400', indeed: 1, zip: 1, google: 'today' },
  week: { label: 'Past week', linkedin: 'r604800', indeed: 7, zip: 5, google: 'week' },
  month: { label: 'Past month', linkedin: 'r2592000', indeed: 30, zip: 30, google: 'month' },
};

export const POSTED_OPTIONS = Object.entries(POSTED).map(([id, v]) => ({ id, label: v.label }));

// LinkedIn's salary filter (f_SB2) uses buckets: 1=$40k+, 2=$60k+ … 9=$200k+
function linkedinSalaryBucket(floor) {
  const n = Number(floor) || 0;
  if (n < 40000) return null;
  return Math.min(9, Math.floor((n - 40000) / 20000) + 1);
}

const AGENCY_WORDS = ['agency', 'staffing', 'recruiting'];

function q(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export function boardLinks(title, profile, search) {
  const posted = POSTED[search.posted] ?? POSTED.week;
  const location = search.remote ? 'United States' : profile.location;
  const quoted = `"${title}"`;
  const noAgency = search.noAgency ? ' ' + AGENCY_WORDS.map((w) => `NOT ${w}`).join(' ') : '';
  const minusAgency = search.noAgency ? ' ' + AGENCY_WORDS.map((w) => `-${w}`).join(' ') : '';

  return [
    {
      id: 'linkedin',
      label: 'LinkedIn',
      url:
        'https://www.linkedin.com/jobs/search/?' +
        q({
          keywords: quoted + noAgency,
          location,
          f_TPR: posted.linkedin,
          f_WT: search.remote ? '2' : '',
          f_JT: 'F',
          f_SB2: linkedinSalaryBucket(profile.salaryFloor) ?? '',
        }),
    },
    {
      id: 'indeed',
      label: 'Indeed',
      url:
        'https://www.indeed.com/jobs?' +
        q({ q: quoted + minusAgency, l: search.remote ? 'Remote' : profile.location, fromage: posted.indeed }),
    },
    {
      id: 'google',
      label: 'Google Jobs',
      url:
        'https://www.google.com/search?' +
        q({
          q: `${title} jobs ${search.remote ? 'remote' : 'near ' + profile.location}`,
          ibp: 'htl;jobs',
        }),
    },
    {
      id: 'direct',
      label: 'Direct employers',
      hint: 'Searches company career sites (Greenhouse, Lever, Workday, etc.), which means no agencies.',
      url:
        'https://www.google.com/search?' +
        q({
          q:
            `${quoted} (site:boards.greenhouse.io OR site:job-boards.greenhouse.io OR site:jobs.lever.co OR site:myworkdayjobs.com OR site:jobs.ashbyhq.com OR site:icims.com)` +
            (search.remote ? ' remote' : ''),
          tbs: `qdr:${posted.google === 'today' ? 'd' : posted.google === 'week' ? 'w' : 'm'}`,
        }),
    },
    {
      id: 'zip',
      label: 'ZipRecruiter',
      url:
        'https://www.ziprecruiter.com/jobs-search?' +
        q({ search: title, location: search.remote ? 'Remote' : profile.location, days: posted.zip }),
    },
    {
      id: 'glassdoor',
      label: 'Glassdoor',
      url: 'https://www.glassdoor.com/Job/jobs.htm?' + q({ 'sc.keyword': title }),
    },
  ];
}

export function companyCareersLink(name, titles) {
  const roles = titles.slice(0, 3).map((t) => `"${t}"`).join(' OR ');
  return 'https://www.google.com/search?' + q({ q: `${name} careers (${roles || 'marketing'})` });
}

export function companyLinkedinLink(name) {
  return 'https://www.linkedin.com/jobs/search/?' + q({ keywords: `${name} marketing` });
}

// Leads that friends send are packed into the URL hash so no server is needed.
export function encodeLead(lead) {
  const json = JSON.stringify(lead);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeLead(str) {
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const lead = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof lead !== 'object' || !lead) return null;
    const clean = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
    return {
      title: clean(lead.title, 200),
      company: clean(lead.company, 200),
      url: clean(lead.url, 1000),
      note: clean(lead.note, 2000),
      from: clean(lead.from, 80),
    };
  } catch {
    return null;
  }
}

export function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}

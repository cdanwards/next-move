// Turns a job posting into structured fields, then reads it against the profile and scorecard.
// Three ways in, one shape out:
//   fetchFromUrl(url)    Greenhouse / Lever / Ashby public APIs (they allow cross-origin reads)
//   fromJsonLd(ld)       schema.org JobPosting data, which the clipper grabs from any job page
//   fromText(text)       pasted text, using heuristics
// Shape: { title, company, location, workMode, salaryMin, salaryMax, description, url, source, ats }

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const ATS_HOSTS = /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|icims\.com|smartrecruiters\.com|jobvite\.com|workable\.com|bamboohr\.com|paylocity\.com|ultipro\.com|adp\.com/;

const AGENCY_TEXT =
  /\b(our client|on behalf of (?:our|a) client|staffing (?:firm|agency|company|partner)|recruiting (?:firm|agency)|contract[- ]to[- ]hire|corp[- ]to[- ]corp|C2C|W-?2 contract)\b/i;
const AGENCY_NAMES =
  /staffing|recruit|talent (?:group|partners|solutions)|search group|robert half|aerotek|insight global|kforce|teksystems|randstad|adecco|kelly services|creative circle|vaco|beacon hill|apex systems|manpower|express employment|aquent|motion recruitment/i;

const BUILD_WORDS =
  /\b(build|develop|launch|create|own|design|program|strategy|strategic|incentive|MDF|co-?op|enablement|playbook|roadmap|go-to-market|GTM)\b/gi;

const TITLE_WORDS =
  /\b(manager|director|specialist|coordinator|lead|head of|vp|vice president|analyst|strategist|marketer|marketing|sales|associate|representative|executive|consultant|partner|brand)\b/i;

// ---------- small utils ----------

export function decodeEntities(s) {
  if (!/&(lt|gt|amp|quot|#\d+);/.test(s)) return s;
  return new DOMParser().parseFromString(s, 'text/html').documentElement.textContent;
}

export function htmlToText(html) {
  if (!html) return '';
  // DOMParser builds an inert document: scripts don't run and images don't load.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach((el) => el.remove());
  doc.querySelectorAll('li').forEach((li) => li.prepend('• '));
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, ul, ol, tr').forEach((el) => el.append('\n'));
  return tidy(doc.body.textContent);
}

function tidy(text) {
  return String(text || '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function prettySlug(slug) {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function annualize(value, unit = '') {
  const v = Number(value);
  if (!v) return '';
  const u = unit.toLowerCase();
  if (/hour|hr/.test(u)) return Math.round(v * 2080);
  if (/month/.test(u)) return Math.round(v * 12);
  if (/week/.test(u)) return Math.round(v * 52);
  return Math.round(v);
}

export function sourceFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const known = {
      linkedin: 'LinkedIn', indeed: 'Indeed', greenhouse: 'Greenhouse', lever: 'Lever', ashbyhq: 'Ashby',
      myworkdayjobs: 'Workday', ziprecruiter: 'ZipRecruiter', glassdoor: 'Glassdoor', icims: 'iCIMS',
    };
    const key = Object.keys(known).find((k) => host.includes(k));
    return key ? known[key] : host;
  } catch {
    return '';
  }
}

function isAtsUrl(url) {
  try {
    return ATS_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// ---------- salary ----------

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kK])?`;
const UNIT = String.raw`(\s*(?:\/|per|an|a)\s*(?:hr|hour|year|yr|annum|month|mo)\b)?`;
const RANGE_RE = new RegExp(String.raw`\$\s?${NUM}${UNIT}\s*(?:-|–|—|to)\s*\$?\s?${NUM}(?:\s*USD)?${UNIT}`, 'i');
const SINGLE_RE = /\$\s?(\d{2,3},\d{3}|\d{2,3}(?:\.\d+)?\s?[kK])(?!\s*(?:-|–|to))/;

function num(n, k) {
  return parseFloat(String(n).replace(/,/g, '')) * (k ? 1000 : 1);
}

export function findSalary(text) {
  const m = RANGE_RE.exec(text);
  if (m) {
    // groups: 1 low, 2 k, 3 unit, 4 high, 5 k, 6 unit
    let lo = num(m[1], m[2] || m[5]);
    let hi = num(m[4], m[5]);
    const unit = `${m[3] || ''} ${m[6] || ''}`;
    const hourly = /hr|hour/i.test(unit) || (hi < 300 && hi > 10);
    if (hourly) {
      lo = annualize(lo, 'hour');
      hi = annualize(hi, 'hour');
    } else if (/month|\bmo\b/i.test(unit)) {
      lo = annualize(lo, 'month');
      hi = annualize(hi, 'month');
    }
    if (lo >= 20000 && hi <= 1000000 && hi >= lo) return { salaryMin: Math.round(lo), salaryMax: Math.round(hi) };
  }
  const s = SINGLE_RE.exec(text);
  if (s) {
    const v = num(s[1].replace(/\s?[kK]$/, ''), /[kK]$/.test(s[1]));
    if (v >= 20000 && v <= 1000000) return { salaryMin: Math.round(v), salaryMax: '' };
  }
  return {};
}

// ---------- location & work mode ----------

const STATE_ABBR = Object.keys(STATES).join('|');
const STATE_NAMES = Object.values(STATES).join('|');
const CITY_RE = new RegExp(String.raw`\b([A-Z][a-zA-Z.'\-]+(?: [A-Z][a-zA-Z.'\-]+){0,3}),\s*(${STATE_ABBR}|${STATE_NAMES})\b`);

export function findLocation(text) {
  const m = CITY_RE.exec(text);
  return m ? `${m[1]}, ${m[2]}` : '';
}

export function findWorkMode(text) {
  if (/\bhybrid\b/i.test(text)) return 'Hybrid';
  if (/\b(fully remote|100% remote|remote[- ]first|remote position|remote role|work from home|remote \(|remote,? (?:us|united states))\b/i.test(text)) return 'Remote';
  if (/\b(on-?site|in[- ]office|in the office \d|onsite)\b/i.test(text)) return 'On-site';
  if (/(^|\n)\s*remote\s*($|\n)/i.test(text) || /·\s*remote\b/i.test(text)) return 'Remote';
  return '';
}

// ---------- from pasted text ----------

export function fromText(text, hints = {}) {
  const clean = tidy(text);
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = { description: clean, ...findSalary(clean) };

  out.workMode = findWorkMode(clean);
  out.location = findLocation(lines.slice(0, 15).join('\n')) || findLocation(clean);

  // Title: an explicit hint, or the first early line that reads like a job title
  out.title =
    hints.title ||
    lines.slice(0, 8).find((l) => l.length < 90 && TITLE_WORDS.test(l) && !/[.!?]$/.test(l) && !/^about\b/i.test(l)) ||
    '';

  // Company: a hint, "Company · City, ST · …" lines (LinkedIn copy), "About Company", or the line after the title
  let company = hints.company || '';
  if (!company) {
    const dotted = lines.slice(0, 10).find((l) => l.includes(' · '));
    if (dotted) {
      const first = dotted.split(' · ')[0].trim();
      if (first && first !== out.title && !CITY_RE.test(first) && first.length < 60) company = first;
    }
  }
  if (!company) {
    const about = clean.match(/\nAbout ((?!the |this |you|us\b|our |the$)[A-Z][\w&.'’\- ]{1,40})\n/);
    if (about) company = about[1].trim();
  }
  if (!company && out.title) {
    const i = lines.indexOf(out.title);
    const next = lines[i + 1];
    if (next && next.length < 50 && !/\d/.test(next) && !CITY_RE.test(next) && !/remote|hybrid|on-?site/i.test(next)) company = next;
  }
  out.company = company;
  return out;
}

// ---------- from schema.org JobPosting ----------

export function findJobPosting(data) {
  if (!data) return null;
  if (Array.isArray(data)) {
    for (const d of data) {
      const hit = findJobPosting(d);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof data !== 'object') return null;
  const type = [].concat(data['@type'] || []);
  if (type.includes('JobPosting')) return data;
  return findJobPosting(data['@graph']);
}

export function fromJsonLd(ld, pageUrl = '') {
  if (!ld) return {};
  const org = ld.hiringOrganization;
  const locs = [].concat(ld.jobLocation || []);
  const addr = locs[0]?.address || {};
  const location = [addr.addressLocality, addr.addressRegion].filter(Boolean).join(', ');
  const salary = ld.baseSalary?.value || ld.estimatedSalary?.value || {};
  const unit = salary.unitText || ld.baseSalary?.unitText || 'YEAR';
  const description = htmlToText(decodeEntities(ld.description || ''));
  const fromDesc = fromText(description);
  return {
    title: tidy(decodeEntities(ld.title || '')),
    company: tidy(typeof org === 'string' ? org : org?.name || ''),
    location: location || fromDesc.location,
    workMode: [].concat(ld.jobLocationType || []).includes('TELECOMMUTE') ? 'Remote' : fromDesc.workMode,
    salaryMin: annualize(salary.minValue ?? salary.value, unit) || fromDesc.salaryMin || '',
    salaryMax: annualize(salary.maxValue, unit) || fromDesc.salaryMax || '',
    description,
    url: ld.url || pageUrl,
  };
}

// ---------- from URL (public ATS APIs) ----------

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(res.status === 404 ? 'That posting wasn’t found. It may be closed.' : `The job site answered with an error (${res.status}).`);
  return res.json();
}

export async function fetchFromUrl(raw) {
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('That doesn’t look like a link.');
  }
  const host = u.hostname;
  const parts = u.pathname.split('/').filter(Boolean);

  // Greenhouse: boards.greenhouse.io/{board}/jobs/{id}, job-boards.greenhouse.io/…, or embed links with ?for=&token=
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    let board = parts[0];
    let id = parts[1] === 'jobs' ? parts[2] : '';
    if (parts[0] === 'embed') {
      board = u.searchParams.get('for');
      id = u.searchParams.get('token');
    }
    if (board && id) {
      const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}?pay_transparency=true`);
      const description = htmlToText(decodeEntities(d.content || ''));
      const pay = (d.pay_input_ranges || []).find((p) => !p.currency_type || p.currency_type === 'USD') || d.pay_input_ranges?.[0];
      const fromDesc = fromText(description);
      return {
        title: d.title,
        company: d.company_name || prettySlug(board),
        location: (d.location?.name || '').trim() || fromDesc.location,
        workMode: findWorkMode(`${d.location?.name || ''}\n${description}`),
        salaryMin: pay ? Math.round(pay.min_cents / 100) : fromDesc.salaryMin || '',
        salaryMax: pay ? Math.round(pay.max_cents / 100) : fromDesc.salaryMax || '',
        description,
        url: raw.trim(),
        source: 'Greenhouse',
        ats: true,
      };
    }
  }

  // Lever: jobs.lever.co/{company}/{id}
  if (/(^|\.)lever\.co$/.test(host) && parts.length >= 2) {
    const api = host.includes('.eu.') ? 'https://api.eu.lever.co' : 'https://api.lever.co';
    const d = await getJson(`${api}/v0/postings/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`);
    const lists = (d.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join('\n\n');
    const description = tidy([d.openingPlain, d.descriptionBodyPlain || d.descriptionPlain, lists, d.additionalPlain].filter(Boolean).join('\n\n'));
    const modes = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site', 'on-site': 'On-site' };
    const sr = d.salaryRange;
    const unit = sr?.interval || '';
    const fromDesc = fromText(description);
    return {
      title: d.text,
      company: prettySlug(parts[0]),
      location: d.categories?.location || fromDesc.location,
      workMode: modes[d.workplaceType] || fromDesc.workMode,
      salaryMin: sr ? annualize(sr.min, unit) : fromDesc.salaryMin || '',
      salaryMax: sr ? annualize(sr.max, unit) : fromDesc.salaryMax || '',
      description,
      url: d.hostedUrl || raw.trim(),
      source: 'Lever',
      ats: true,
    };
  }

  // Ashby: jobs.ashbyhq.com/{org}/{id}
  if (host === 'jobs.ashbyhq.com' && parts.length >= 2) {
    const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(parts[0])}?includeCompensation=true`);
    const j = (d.jobs || []).find((x) => x.id === parts[1]);
    if (!j) throw new Error('That posting wasn’t found. It may be closed.');
    const salary = (j.compensation?.compensationTiers?.[0]?.components || []).find((c) => c.compensationType === 'Salary');
    const description = tidy(j.descriptionPlain || htmlToText(j.descriptionHtml));
    const modes = { Remote: 'Remote', Hybrid: 'Hybrid', OnSite: 'On-site' };
    const fromDesc = fromText(description);
    return {
      title: j.title,
      company: prettySlug(parts[0]),
      location: j.location || fromDesc.location,
      workMode: modes[j.workplaceType] || (j.isRemote ? 'Remote' : fromDesc.workMode),
      salaryMin: salary?.minValue ? annualize(salary.minValue, salary.interval) : fromDesc.salaryMin || '',
      salaryMax: salary?.maxValue ? annualize(salary.maxValue, salary.interval) : fromDesc.salaryMax || '',
      description,
      url: j.jobUrl || raw.trim(),
      source: 'Ashby',
      ats: true,
    };
  }

  const site = sourceFromUrl(raw);
  const err = new Error(
    `${site || 'This site'} doesn’t let other sites read its postings. Use the Clip button on the posting, or copy the text and paste it below.`
  );
  err.unsupported = true;
  throw err;
}

// ---------- from the clipper bookmarklet ----------

export function fromClip(clip) {
  const pageUrl = clip.url || '';
  const ld = findJobPosting(clip.ld);
  const text = clip.sel || clip.text || '';
  const hints = { title: clip.h1 || '', company: clip.company || '' };
  const base = ld ? fromJsonLd(ld, pageUrl) : {};
  const txt = fromText(text, hints);
  const merged = { ...txt };
  for (const [k, v] of Object.entries(base)) if (v) merged[k] = v;
  // A highlighted selection is what the person chose, so it wins for the description
  if (clip.sel) merged.description = tidy(clip.sel);
  merged.url = pageUrl || merged.url || '';
  merged.source = sourceFromUrl(pageUrl);
  merged.ats = isAtsUrl(pageUrl);
  return merged;
}

export function decodePayload(str) {
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// The bookmarklet runs on the job page. It sends structured data, the selection, and a best-guess
// description block to the app in the URL hash. The hash never reaches a server.
export function bookmarkletCode(appUrl) {
  const src = `(()=>{
var A=${JSON.stringify(appUrl)};
var q=function(s){for(var i=0;i<s.length;i++){var e=document.querySelector(s[i]);if(e&&e.innerText&&e.innerText.trim())return e.innerText.trim()}return ''};
var ld=[];document.querySelectorAll('script[type="application/ld+json"]').forEach(function(s){try{ld.push(JSON.parse(s.textContent))}catch(e){}});
var p={url:location.href,
h1:q(['.job-details-jobs-unified-top-card__job-title','.top-card-layout__title','[data-testid="jobsearch-JobInfoHeader-title"]','[data-automation-id="jobPostingHeader"]','h1']).slice(0,200),
company:q(['.job-details-jobs-unified-top-card__company-name','.topcard__org-name-link','[data-testid="inlineHeader-companyName"]','[data-company-name]']).slice(0,120),
sel:String(getSelection()).trim().slice(0,15000),
text:q(['#jobDescriptionText','.jobs-description__content','.jobs-description-content__text','.show-more-less-html__markup','[data-automation-id="jobPostingDescription"]','.job-description','[class*="jobDescription"]','[class*="job-description"]','main','article','body']).slice(0,15000),
ld:ld};
var j=JSON.stringify(p);if(j.length>60000){p.ld=[];j=JSON.stringify(p)}
var b=btoa(unescape(encodeURIComponent(j))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
window.open(A+'#/import?d='+b,'nextmove');
})()`;
  return 'javascript:' + encodeURIComponent(src.replace(/\n/g, ''));
}

// ---------- analysis against profile & scorecard ----------

function yearsAsked(text) {
  const m = text.match(/(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*)?\+?\s*years?(?:'|’)?\s*(?:of\s+)?(?:[\w\-/]+\s+){0,4}experience/i);
  return m ? Number(m[1]) : null;
}

function money(n) {
  return `$${Math.round(Number(n) / 1000)}k`;
}

// Returns { suggestions: {criterionId: 0|1|2}, notes: [{tone, text}], keywords: [] }.
// Suggestions only cover what text can reasonably reveal; "would they value me" is left to him.
export function analyze(job, profile) {
  const text = `${job.title}\n${job.company}\n${job.location}\n${job.description || ''}`;
  const suggestions = {};
  const notes = [];

  // Direct hire?
  const agencyHit = text.match(AGENCY_TEXT);
  if (agencyHit || AGENCY_NAMES.test(job.company || '')) {
    suggestions.direct = 0;
    notes.push({ tone: 'bad', text: agencyHit ? `Agency or contract language: “${agencyHit[0]}”` : `${job.company} looks like a staffing firm` });
  } else if (job.ats || isAtsUrl(job.url)) {
    suggestions.direct = 2;
    notes.push({ tone: 'good', text: 'Posted on the company’s own careers site' });
  }

  // Pay vs floor
  const floor = Number(profile.salaryFloor) || 0;
  const lo = Number(job.salaryMin) || 0;
  const hi = Number(job.salaryMax) || lo;
  if (hi && floor) {
    const range = lo && hi !== lo ? `${money(lo)}–${money(hi)}` : money(hi);
    if (hi < floor) {
      suggestions.pay = 0;
      notes.push({ tone: 'bad', text: `Pay ${range} tops out under your ${money(floor)} floor` });
    } else if (lo >= floor) {
      suggestions.pay = 2;
      notes.push({ tone: 'good', text: `Pay ${range} clears your ${money(floor)} floor` });
    } else {
      suggestions.pay = 1;
      notes.push({ tone: 'meh', text: `Pay ${range} straddles your ${money(floor)} floor. Aim for the top half.` });
    }
  } else if (!hi) {
    notes.push({ tone: 'meh', text: 'No pay listed. Ask for the range on the first call.' });
  }

  // Place
  const home = (profile.location || '').split(',')[0].trim().toLowerCase();
  const loc = (job.location || '').toLowerCase();
  if (job.workMode === 'Remote') {
    suggestions.place = 2;
    notes.push({ tone: 'good', text: 'Remote' });
  } else if (home && loc.includes(home)) {
    suggestions.place = 2;
    notes.push({ tone: 'good', text: `In ${job.location}, no move needed` });
  } else if (loc) {
    const willing = ['open', 'eager'].includes(profile.relocation);
    suggestions.place = willing ? 1 : 0;
    notes.push({ tone: willing ? 'meh' : 'bad', text: `${job.workMode || 'Based'} in ${job.location}, which means moving. Ask about relocation help.` });
  }

  // Building programs
  const builds = new Set((text.match(BUILD_WORDS) || []).map((w) => w.toLowerCase()));
  if (builds.size >= 5) suggestions.build = 2;
  else if (builds.size >= 2) suggestions.build = 1;
  if (builds.size >= 2) notes.push({ tone: builds.size >= 5 ? 'good' : 'meh', text: `Builder language: ${[...builds].slice(0, 6).join(', ')}` });

  // Experience asked vs his
  const asked = yearsAsked(text);
  const mine = Number(profile.yearsExperience) || 0;
  if (asked && mine) {
    if (asked > mine + 2) notes.push({ tone: 'meh', text: `Asks for ${asked}+ years; you have ${mine}. Apply anyway if the rest fits.` });
    else notes.push({ tone: 'good', text: `Asks for ${asked}+ years; you have ${mine}` });
  }

  // His strengths that show up in the posting
  const lower = text.toLowerCase();
  const keywords = (profile.keywords || []).filter((k) => k && lower.includes(k.toLowerCase()));

  return { suggestions, notes, keywords };
}

// ---------- wins from a resume or LinkedIn "Experience" section ----------

const WIN_SIGNAL =
  /(\d+\s?%|\$\s?\d|\d+\s?[kKmM]\b|\d+x\b|award|addy|increas|grew|growth|reduc|saved|cut\b|launch|led\b|built|won\b|drove|boost|doubled|tripled|record|first\b)/i;

// Splits pasted text into sentences and bullets, then keeps the ones that read like accomplishments.
export function extractWins(text, max = 15) {
  const pieces = tidy(text)
    .split(/\n|•|·|(?<=[.!?])\s+(?=[A-Z])/)
    .map((p) => p.replace(/^[\s\-–—*]+/, '').trim())
    .filter((p) => p.length >= 25 && p.length <= 300);
  const seen = new Set();
  const wins = [];
  for (const p of pieces) {
    if (/^(skills?|endorsements?|location)\s*:/i.test(p)) continue;
    // Needs an action/result word AND something concrete: a percent, dollars, a multiple, a count, or an award
    if (!WIN_SIGNAL.test(p) || !/\d+\s?(%|percent|[kKmM]\b|x\b)|\$\s?\d|\b\d{2,}\b|award/i.test(p)) continue;
    const k = p.toLowerCase().slice(0, 60);
    if (seen.has(k)) continue;
    seen.add(k);
    wins.push(p.replace(/\s+/g, ' ').replace(/([^.!?])$/, '$1.'));
    if (wins.length >= max) break;
  }
  return wins;
}

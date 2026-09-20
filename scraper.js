const axios = require('axios');
const cheerio = require('cheerio');
const supabase = require('./supabaseClient');

// Standard checklist — kept simple on purpose, same for every job for now
const STANDARD_DOCS = '10th/SSC certificate, Intermediate/Degree certificate, Aadhar card, Recent passport-size photo, Caste certificate (if applicable), Study/Residence certificate, Signature scan';

// Sources to watch. Add more portals here later using the same pattern.
const SOURCES = [
  { url: 'https://slprb.ap.gov.in/', name: 'SLPRB' },
  { url: 'https://psc.ap.gov.in/', name: 'APPSC' }
];

// Keywords to detect which job type a notification link is about
const JOB_KEYWORDS = [
  { match: /constable/i, jobType: 'Police Constable' },
  { match: /\bmro\b/i, jobType: 'MRO' },
  { match: /\bvro\b/i, jobType: 'VRO' },
  { match: /group[\s-]?2/i, jobType: 'Group 2' },
  { match: /group[\s-]?4/i, jobType: 'Group 4' }
];

async function scrapeSource(source) {
  try {
    const { data: html } = await axios.get(source.url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const $ = cheerio.load(html);
    const foundLinks = [];

    $('a').each((i, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr('href');
      if (!text || !href) return;

      for (const kw of JOB_KEYWORDS) {
        if (kw.match.test(text)) {
          let fullLink = href;
          if (!href.startsWith('http')) {
            fullLink = new URL(href, source.url).href;
          }
          foundLinks.push({ title: text, link: fullLink, jobType: kw.jobType });
        }
      }
    });

    return foundLinks;
  } catch (err) {
    console.log(`Scrape failed for ${source.name}:`, err.message);
    return [];
  }
}

async function runScraper() {
  console.log('🔍 Running scraper check...');
  for (const source of SOURCES) {
    const found = await scrapeSource(source);

    for (const item of found) {
      // Check if this exact link is already saved
      const { data: existing } = await supabase
        .from('live_jobs')
        .select('id')
        .eq('portal_link', item.link)
        .maybeSingle();

      if (!existing) {
        await supabase.from('live_jobs').insert({
          district: 'State-wide',
          job_type: item.jobType,
          title: item.title,
          portal_link: item.link,
          documents_required: STANDARD_DOCS,
          last_updated: new Date()
        });
        console.log(`✅ New notification added: ${item.jobType} — ${item.title}`);
      }
    }
  }
  console.log('Scraper check complete.');
}

module.exports = { runScraper };

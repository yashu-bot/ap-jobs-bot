const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const axios = require('axios');
const cheerio = require('cheerio');
const supabase = require('./supabaseClient');

const STANDARD_DOCS = '10th/SSC certificate, Intermediate/Degree certificate, Aadhar card, Recent passport-size photo, Caste certificate (if applicable), Study/Residence certificate, Signature scan';

const SOURCES = [
  { url: 'https://slprb.ap.gov.in/', name: 'SLPRB' },
  { url: 'https://psc.ap.gov.in/', name: 'APPSC' }
];

const JOB_KEYWORDS = [
  { match: /constable/i, jobType: 'Police Constable' },
  { match: /\bmro\b/i, jobType: 'MRO' },
  { match: /\bvro\b/i, jobType: 'VRO' },
  { match: /group[\s-]?2/i, jobType: 'Group 2' },
  { match: /group[\s-]?4/i, jobType: 'Group 4' }
];

async function scrapeSource(source) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data: html } = await axios.get(source.url, {
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
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
      console.log(`Attempt ${attempt} failed for ${source.name}:`, err.message);
      if (attempt === 3) return [];
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function runScraper() {
  console.log('🔍 Running scraper check...');
  for (const source of SOURCES) {
    const found = await scrapeSource(source);

    for (const item of found) {
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

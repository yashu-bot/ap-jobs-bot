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
      const proxyUrl = 'https://r.jina.ai/' + source.url;
      const { data: text } = await axios.get(proxyUrl, {
        timeout: 25000
      });

      const foundLinks = [];
      const lines = text.split('\n');

      for (const line of lines) {
        for (const kw of JOB_KEYWORDS) {
          if (kw.match.test(line)) {
            const urlMatch = line.match(/https?:\/\/[^\s)]+/);
            foundLinks.push({
              title: line.trim().slice(0, 200),
              link: urlMatch ? urlMatch[0] : source.url,
              jobType: kw.jobType
            });
          }
        }
      }

      return foundLinks;
    } catch (err) {
      const detail = err.response?.data || err.message;
      console.log(`Attempt ${attempt} failed for ${source.name}:`, detail);
      if (attempt === 3) return [];
      await new Promise(r => setTimeout(r, 4000));
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

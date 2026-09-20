const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const axios = require('axios');
const cheerio = require('cheerio');
const supabase = require('./supabaseClient');

const STANDARD_DOCS = '10th/SSC certificate, Intermediate/Degree certificate, Aadhar card, Recent passport-size photo, Caste certificate (if applicable), Study/Residence certificate, Signature scan';

const FEED_URL = 'https://www.apteachers.in/feeds/posts/default?alt=rss&max-results=50';

// Order matters: more specific patterns are checked first to avoid double-tagging
const JOB_KEYWORDS = [
  { match: /head\s*constable/i, jobType: 'Head Constable' },
  { match: /excise\s*constable/i, jobType: 'Excise Constable' },
  { match: /(?<!head\s)(?<!excise\s)\bconstable\b/i, jobType: 'Police Constable' },
  { match: /sub[\s-]?inspector|\bSI\b/i, jobType: 'Sub Inspector' },
  { match: /forest\s*beat\s*officer|forest\s*range\s*officer/i, jobType: 'Forest Beat Officer' },
  { match: /\bmro\b/i, jobType: 'MRO' },
  { match: /\bvro\b/i, jobType: 'VRO' },
  { match: /degree\s*lecturer/i, jobType: 'Degree Lecturer' },
  { match: /junior\s*lecturer/i, jobType: 'Junior Lecturer' },
  { match: /\bDSC\b|teacher\s*recruitment|\bSGT\b|school\s*assistant/i, jobType: 'Teacher / DSC' },
  { match: /group[\s-]?1\b/i, jobType: 'Group 1' },
  { match: /group[\s-]?2\b/i, jobType: 'Group 2' },
  { match: /group[\s-]?3\b/i, jobType: 'Group 3' },
  { match: /group[\s-]?4\b/i, jobType: 'Group 4' },
  { match: /junior\s*assistant/i, jobType: 'Junior Assistant' },
  { match: /panchayat\s*secretary/i, jobType: 'Panchayat Secretary' },
  { match: /sachivalayam/i, jobType: 'Grama/Ward Sachivalayam' },
  { match: /ward\s*volunteer|village\s*volunteer/i, jobType: 'Village/Ward Volunteer' },
  { match: /anganwadi/i, jobType: 'Anganwadi' },
  { match: /staff\s*nurse|health\s*department\s*recruitment|\bANM\b/i, jobType: 'Health Department' },
  { match: /agriculture\s*officer/i, jobType: 'Agriculture Officer' },
  { match: /APSPDCL|APEPDCL|APCPDCL|power\s*department\s*recruitment/i, jobType: 'Power Department (DISCOM)' },
  { match: /APSRTC|RTC\s*recruitment/i, jobType: 'APSRTC' },
  { match: /high\s*court.*recruitment|recruitment.*high\s*court/i, jobType: 'High Court Staff' }
];

// Anything AP govt-related that didn't match a specific category above
const GENERIC_MATCH = /recruitment|notification|vacanc(y|ies)|walk-?in/i;

// Which state this source belongs to — apteachers.in is AP-focused
const SOURCE_STATE = 'Andhra Pradesh';

async function scrapeFeed() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data: xml } = await axios.get(FEED_URL, {
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });

      const $ = cheerio.load(xml, { xmlMode: true });
      const foundLinks = [];

      $('item').each((i, el) => {
        const title = $(el).find('title').text().trim();
        const link = $(el).find('link').text().trim();
        if (!title || !link) return;

        let matchedSpecific = false;
        for (const kw of JOB_KEYWORDS) {
          if (kw.match.test(title)) {
            foundLinks.push({ title, link, jobType: kw.jobType });
            matchedSpecific = true;
          }
        }

        if (!matchedSpecific && GENERIC_MATCH.test(title)) {
          foundLinks.push({ title, link, jobType: 'Other AP Govt Jobs' });
        }
      });

      return foundLinks;
    } catch (err) {
      console.log(`Attempt ${attempt} failed:`, err.message);
      if (attempt === 3) return [];
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function runScraper() {
  console.log('🔍 Running scraper check...');
  const found = await scrapeFeed();
  console.log(`Found ${found.length} matching entries in feed.`);

  for (const item of found) {
    const { data: existing } = await supabase
      .from('live_jobs')
      .select('id')
      .eq('portal_link', item.link)
      .eq('job_type', item.jobType)
      .maybeSingle();

    if (!existing) {
      await supabase.from('live_jobs').insert({
        district: SOURCE_STATE,
        job_type: item.jobType,
        title: item.title,
        portal_link: item.link,
        documents_required: STANDARD_DOCS,
        last_updated: new Date()
      });
      console.log(`✅ New: ${item.jobType} — ${item.title}`);
    }
  }
  console.log('Scraper check complete.');
}

module.exports = { runScraper };

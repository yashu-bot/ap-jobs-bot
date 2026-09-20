const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const axios = require('axios');
const cheerio = require('cheerio');
const supabase = require('./supabaseClient');

const STANDARD_DOCS = '10th/SSC certificate, Intermediate/Degree certificate, Aadhar card, Recent passport-size photo, Caste certificate (if applicable), Study/Residence certificate, Signature scan';

// RSS feed of an AP government jobs news site — reliable, fast, built for automated reading
const FEED_URL = 'https://www.apteachers.in/feeds/posts/default?alt=rss&max-results=30';

const JOB_KEYWORDS = [
  { match: /constable/i, jobType: 'Police Constable' },
  { match: /\bmro\b/i, jobType: 'MRO' },
  { match: /\bvro\b/i, jobType: 'VRO' },
  { match: /group[\s-]?2/i, jobType: 'Group 2' },
  { match: /group[\s-]?4/i, jobType: 'Group 4' }
];

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

        for (const kw of JOB_KEYWORDS) {
          if (kw.match.test(title)) {
            foundLinks.push({ title, link, jobType: kw.jobType });
          }
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
  console.log(`Found ${found.length} matching notification(s) in feed.`);

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
  console.log('Scraper check complete.');
}

module.exports = { runScraper };

const express = require('express');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const cron = require('node-cron');
const supabase = require('./supabaseClient');
const { runScraper } = require('./scraper');

const app = express();
app.use(express.json());

const AUTH_FOLDER = './auth_info';
const userState = {};
let currentQR = null;
let isConnected = false;

const STATES = ['Andhra Pradesh', 'Telangana'];

const CATEGORIES = {
  'Police & Security': ['Police Constable', 'Sub Inspector', 'Head Constable', 'Excise Constable', 'Forest Beat Officer'],
  'Revenue Department': ['MRO', 'VRO'],
  'Teaching & Education': ['Teacher / DSC', 'Junior Lecturer', 'Degree Lecturer'],
  'APPSC Group Services': ['Group 1', 'Group 2', 'Group 3', 'Group 4'],
  'Secretariat & Panchayat': ['Junior Assistant', 'Panchayat Secretary', 'Grama/Ward Sachivalayam', 'Village/Ward Volunteer'],
  'Other Departments': ['Anganwadi', 'Health Department', 'Agriculture Officer', 'Power Department (DISCOM)', 'APSRTC', 'High Court Staff']
};

const CATEGORY_NAMES = Object.keys(CATEGORIES);

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      isConnected = false;
      console.log('New QR generated — visit /qr on your Render URL to scan it');
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('✅ Bot connected to WhatsApp');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const phone = from.split('@')[0];
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    await handleMessage(sock, from, phone, text.trim());
  });
}

// Picks an option from a list either by number (1,2,3...) or by typed name (partial match allowed)
function resolveChoice(input, options) {
  const trimmed = input.trim();
  const asNumber = parseInt(trimmed, 10);
  if (!isNaN(asNumber) && asNumber >= 1 && asNumber <= options.length) {
    return options[asNumber - 1];
  }
  const lower = trimmed.toLowerCase();
  const exact = options.find(o => o.toLowerCase() === lower);
  if (exact) return exact;
  const partial = options.find(o => o.toLowerCase().includes(lower) || lower.includes(o.toLowerCase()));
  return partial || null;
}

async function handleMessage(sock, jid, phone, text) {
  if (!userState[phone]) userState[phone] = { step: 'start' };
  const state = userState[phone];
  const lower = text.toLowerCase();

  if (lower === 'hi' || lower === 'start' || lower === 'menu') {
    state.step = 'state';
    await sendNumberedList(sock, jid, 'Select your State', STATES);
    return;
  }

  if (state.step === 'state') {
    const matched = resolveChoice(text, STATES);
    if (matched) {
      state.selectedState = matched;
      state.step = 'category';
      const allOptions = [...CATEGORY_NAMES, 'All Govt Jobs'];
      await sendNumberedList(sock, jid, `Select Job Category (${matched})`, allOptions);
      return;
    }
  }

  if (state.step === 'category') {
    const allOptions = [...CATEGORY_NAMES, 'All Govt Jobs'];
    const matched = resolveChoice(text, allOptions);
    if (matched === 'All Govt Jobs') {
      await checkAndReply(sock, jid, phone, state.selectedState, null);
      return;
    }
    if (matched && CATEGORIES[matched]) {
      state.selectedCategory = matched;
      state.step = 'jobtype';
      await sendNumberedList(sock, jid, `Select job under ${matched}`, CATEGORIES[matched]);
      return;
    }
  }

  if (state.step === 'jobtype') {
    const options = CATEGORIES[state.selectedCategory] || [];
    const matched = resolveChoice(text, options);
    if (matched) {
      await checkAndReply(sock, jid, phone, state.selectedState, matched);
      return;
    }
  }

  await sock.sendMessage(jid, { text: 'Type "Hi" to start checking job notifications.' });
}

async function sendNumberedList(sock, jid, title, options) {
  const listText = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  await sock.sendMessage(jid, {
    text: `${title}\n\n${listText}\n\nReply with the number (e.g. "1") or the name.`
  });
}

async function checkAndReply(sock, jid, phone, selectedState, jobType) {
  await supabase.from('users').upsert(
    { phone, job_type: jobType || 'All Govt Jobs', last_interaction: new Date() },
    { onConflict: 'phone' }
  );

  const { data: userRow } = await supabase
    .from('users')
    .select('paid_status, expiry_date')
    .eq('phone', phone)
    .single();

  const isPaid =
    userRow?.paid_status &&
    userRow?.expiry_date &&
    new Date(userRow.expiry_date) > new Date();

  let query = supabase
    .from('live_jobs')
    .select('*')
    .eq('district', selectedState)
    .order('last_updated', { ascending: false })
    .limit(10);

  if (jobType) {
    query = query.eq('job_type', jobType);
  }

  const { data: jobs } = await query;

  if (!jobs || jobs.length === 0) {
    await sock.sendMessage(jid, {
      text: `No active notification right now for ${jobType || 'any category'} in ${selectedState}. We'll notify you when one opens.\n\nType "Hi" to search again.`
    });
    return;
  }

  for (const job of jobs) {
    if (isPaid) {
      await sock.sendMessage(jid, {
        text: `✅ ${job.title}\n\nApply here: ${job.portal_link}\n\nDocuments needed:\n${job.documents_required}`
      });
    } else {
      const paymentMsg = process.env.RAZORPAY_PAYMENT_LINK
        ? `Subscribe for ₹199/year to get the direct apply link + full checklist instantly:\n${process.env.RAZORPAY_PAYMENT_LINK}`
        : `Subscribe for ₹199/year to unlock the direct apply link + document checklist. Payments open soon!`;
      await sock.sendMessage(jid, {
        text: `✅ Active notification found: ${job.title}\n\n${paymentMsg}`
      });
    }
  }

  await sock.sendMessage(jid, { text: 'Type "Hi" to search again.' });
}

app.post('/razorpay-webhook', async (req, res) => {
  const payload = req.body;
  if (payload.event === 'payment.captured') {
    const phone = payload.payload.payment.entity.contact?.replace('+91', '');
    if (phone) {
      const expiry = new Date();
      expiry.setFullYear(expiry.getFullYear() + 1);
      await supabase.from('users').upsert(
        { phone, paid_status: true, expiry_date: expiry.toISOString().split('T')[0] },
        { onConflict: 'phone' }
      );
    }
  }
  res.sendStatus(200);
});

app.get('/qr', async (req, res) => {
  if (isConnected) {
    return res.send('<h2>✅ Bot is already connected to WhatsApp. No QR needed.</h2>');
  }
  if (!currentQR) {
    return res.send('<h2>No QR available yet. Wait a few seconds and refresh.</h2><script>setTimeout(()=>location.reload(),3000)</script>');
  }
  const qrImage = await qrcode.toDataURL(currentQR);
  res.send(`
    <html>
      <body style="text-align:center; font-family:sans-serif; padding-top:40px;">
        <h2>Scan this with WhatsApp → Linked Devices</h2>
        <img src="${qrImage}" style="width:300px;height:300px;" />
        <p>This page auto-refreshes every 5 seconds until connected.</p>
        <script>setTimeout(() => location.reload(), 5000);</script>
      </body>
    </html>
  `);
});

app.get('/run-scraper', async (req, res) => {
  await runScraper();
  res.send('Scraper ran — check Render logs for results.');
});

app.get('/', (req, res) => res.send('Bot is alive'));

app.listen(process.env.PORT || 3000, () => console.log('Server running'));

runScraper();
cron.schedule('*/30 * * * *', runScraper);
startBot();

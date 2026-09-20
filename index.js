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
const fs = require('fs');
const path = require('path');
const supabase = require('./supabaseClient');
const { runScraper } = require('./scraper');

const app = express();
app.use(express.json());

const AUTH_FOLDER = './auth_info';
const userState = {};
let currentQR = null;
let isConnected = false;
let globalSock = null;

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

async function restoreSessionFromSupabase() {
  try {
    const { data, error } = await supabase
      .from('bot_session')
      .select('data')
      .eq('id', 'whatsapp_auth')
      .maybeSingle();

    if (error || !data || !data.data) {
      console.log('No saved session found in Supabase — fresh QR will be needed.');
      return;
    }

    if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

    const files = data.data;
    for (const filename of Object.keys(files)) {
      fs.writeFileSync(path.join(AUTH_FOLDER, filename), files[filename]);
    }
    console.log(`✅ Restored ${Object.keys(files).length} session file(s) from Supabase.`);
  } catch (err) {
    console.log('Session restore failed:', err.message);
  }
}

async function backupSessionToSupabase() {
  try {
    if (!fs.existsSync(AUTH_FOLDER)) return;
    const filenames = fs.readdirSync(AUTH_FOLDER);
    const files = {};
    for (const filename of filenames) {
      files[filename] = fs.readFileSync(path.join(AUTH_FOLDER, filename), 'utf8');
    }
    await supabase.from('bot_session').upsert({ id: 'whatsapp_auth', data: files });
  } catch (err) {
    console.log('Session backup failed:', err.message);
  }
}

async function clearSavedSession() {
  await supabase.from('bot_session').delete().eq('id', 'whatsapp_auth');
}

async function startBot() {
  await restoreSessionFromSupabase();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' })
  });

  globalSock = sock;

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await backupSessionToSupabase();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      isConnected = false;
      console.log('New QR generated — visit /qr on your Render URL to scan it');
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.log('Logged out — clearing saved session, fresh QR needed.');
        await clearSavedSession();
      }
      console.log('Connection closed. Reconnecting:', !loggedOut);
      if (!loggedOut) startBot();
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('✅ Bot connected to WhatsApp');
      await backupSessionToSupabase();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid; // raw WhatsApp identity — used for conversation state, may be a LID
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    await handleMessage(sock, from, text.trim());
  });
}

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

function isValidPhoneInput(text) {
  const digits = text.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 12;
}

function normalizePhone(text) {
  let digits = text.replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  return digits;
}

async function getCanonicalPhone(waId) {
  const { data } = await supabase.from('users').select('phone').eq('wa_id', waId).maybeSingle();
  return data?.phone || null;
}

async function handleMessage(sock, jid, text) {
  if (!userState[jid]) userState[jid] = { step: 'start' };
  const state = userState[jid];
  const lower = text.toLowerCase();

  if (lower === 'hi' || lower === 'start' || lower === 'menu') {
    const existingPhone = await getCanonicalPhone(jid);
    if (existingPhone) {
      state.phone = existingPhone;
      state.step = 'state';
      await sendNumberedList(sock, jid, 'Select your State', STATES);
    } else {
      state.step = 'ask_phone';
      await sock.sendMessage(jid, {
        text: 'Welcome! To continue, please type your 10-digit mobile number (used only to activate your subscription later).'
      });
    }
    return;
  }

  if (state.step === 'ask_phone') {
    if (isValidPhoneInput(text)) {
      const phone = normalizePhone(text);
      state.phone = phone;
      await supabase.from('users').upsert(
        { wa_id: jid, phone, last_interaction: new Date() },
        { onConflict: 'wa_id' }
      );
      state.step = 'state';
      await sendNumberedList(sock, jid, 'Thanks! Select your State', STATES);
    } else {
      await sock.sendMessage(jid, { text: 'That doesn\'t look like a valid number. Please type your 10-digit mobile number.' });
    }
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
      await checkAndReply(sock, jid, state.phone, state.selectedState, null);
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
      await checkAndReply(sock, jid, state.phone, state.selectedState, matched);
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
  await supabase.from('users').update(
    { job_type: jobType || 'All Govt Jobs', last_interaction: new Date() }
  ).eq('phone', phone);

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
    const rawPhone = payload.payload.payment.entity.contact?.replace('+91', '').replace(/\D/g, '');
    const phone = rawPhone.length === 10 ? '91' + rawPhone : rawPhone;

    if (phone) {
      const expiry = new Date();
      expiry.setFullYear(expiry.getFullYear() + 1);
      await supabase.from('users').update(
        { paid_status: true, expiry_date: expiry.toISOString().split('T')[0] }
      ).eq('phone', phone);

      const { data: row } = await supabase.from('users').select('wa_id').eq('phone', phone).maybeSingle();
      if (row?.wa_id && globalSock) {
        try {
          await globalSock.sendMessage(row.wa_id, {
            text: `✅ Payment received! You're now subscribed for 1 year. Type "Hi" to get your job notifications with full apply links and document checklists.`
          });
        } catch (err) {
          console.log('Could not send confirmation:', err.message);
        }
      }
    }
  }
  res.sendStatus(200);
});

app.get('/mark-paid', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.send('Add ?phone=91XXXXXXXXXX to the URL');

  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);
  const { error } = await supabase.from('users').update(
    { paid_status: true, expiry_date: expiry.toISOString().split('T')[0] }
  ).eq('phone', phone);

  if (error) return res.send('Error: ' + error.message);
  res.send(`✅ ${phone} marked as paid for testing (if that phone exists in users table). Message the bot with "Hi" again to see the full experience.`);
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

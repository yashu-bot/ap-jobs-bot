const qrcode = require('qrcode');
let currentQR = null;
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const supabase = require('./supabaseClient');

const app = express();
app.use(express.json());

const AUTH_FOLDER = './auth_info';
const userState = {};

const DISTRICTS = ['Guntur', 'Anantapur', 'Krishna', 'Visakhapatnam', 'State-wide'];
const JOB_TYPES = ['Police Constable', 'MRO', 'VRO', 'Group 2', 'Group 4'];

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
    if (qr) console.log('SCAN THIS QR STRING (paste into a text-to-QR site):\n', qr);
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
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

async function handleMessage(sock, jid, phone, text) {
  if (!userState[phone]) userState[phone] = { step: 'start' };
  const state = userState[phone];

  if (text.toLowerCase() === 'hi' || text.toLowerCase() === 'start') {
    state.step = 'district';
    await sendList(sock, jid, 'Select your District', DISTRICTS);
    return;
  }

  if (state.step === 'district' && DISTRICTS.includes(text)) {
    state.district = text;
    state.step = 'jobtype';
    await sendList(sock, jid, 'Select Job Type', JOB_TYPES);
    return;
  }

  if (state.step === 'jobtype' && JOB_TYPES.includes(text)) {
    state.jobType = text;
    state.step = 'result';
    await checkAndReply(sock, jid, phone, state.district, state.jobType);
    return;
  }

  await sock.sendMessage(jid, { text: 'Type "Hi" to start checking job notifications.' });
}

async function sendList(sock, jid, title, options) {
  await sock.sendMessage(jid, {
    text: title + '\n\n' + options.map((o, i) => `${i + 1}. ${o}`).join('\n') +
      '\n\nReply with the exact name (e.g. "Guntur").'
  });
}

async function checkAndReply(sock, jid, phone, district, jobType) {
  await supabase.from('users').upsert(
    { phone, district, job_type: jobType, last_interaction: new Date() },
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

  const { data: jobs } = await supabase
    .from('live_jobs')
    .select('*')
    .or(`district.eq.${district},district.eq.State-wide`)
    .eq('job_type', jobType);

  if (!jobs || jobs.length === 0) {
    await sock.sendMessage(jid, {
      text: `No active notification right now for ${jobType} in ${district}. We'll notify you when one opens.`
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

app.get('/', (req, res) => res.send('Bot is alive'));

app.listen(process.env.PORT || 3000, () => console.log('Server running'));
startBot();

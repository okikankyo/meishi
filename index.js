const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '20mb' }));

const pendingData = {};
const pendingMemo = {};
const userModes = {}; // auto / manual

function decodeErrorBody(data) {
  if (!data) return '';
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (typeof data === 'string') return data;
  return JSON.stringify(data);
}

function escapeKintoneQueryValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// =======================
// TOKEN
// =======================
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = (process.env.LW_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n')
    .trim();

  const payload = {
    iss: process.env.LW_CLIENT_ID,
    sub: process.env.LW_SERVICE_ACCOUNT,
    iat: now,
    exp: now + 300
  };

  const assertion = jwt.sign(payload, privateKey, { algorithm: 'RS256' });

  const params = new URLSearchParams();
  params.append('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  params.append('client_id', process.env.LW_CLIENT_ID);
  params.append('client_secret', process.env.LW_CLIENT_SECRET);
  params.append('assertion', assertion);
  params.append('scope', 'bot bot.message');

  const res = await axios.post(
    'https://auth.worksmobile.com/oauth2/v2.0/token',
    params,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return res.data.access_token;
}

// =======================
// SEND
// =======================
async function sendMessage(text) {
  const token = await getAccessToken();

  await axios.post(
    `https://www.worksapis.com/v1.0/bots/${process.env.LW_BOT_ID}/channels/${process.env.LW_TARGET_CHANNEL_ID}/messages`,
    { content: { type: 'text', text } },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

// =======================
// OCR
// =======================
async function analyzeBusinessCard(imageDataUrl) {
  const res = await axios.post(
    'https://api.openai.com/v1/responses',
    {
      model: 'gpt-4.1-mini',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `名刺をJSONで抽出
{
"name":"","company":"","department":"","position":"",
"phone":"","mobile":"","fax":"","email":"",
"address":"","memo":""
}`
            },
            { type: 'input_image', image_url: imageDataUrl }
          ]
        }
      ]
    },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  );

  const raw = res.data.output?.[0]?.content?.[0]?.text || '';
  const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();

  return JSON.parse(cleaned);
}

// =======================
// REGISTER
// =======================
async function register(data, userId) {
  await axios.post(
    `https://${process.env.KINTONE_SUBDOMAIN}.cybozu.com/k/v1/record.json`,
    {
      app: Number(process.env.KINTONE_APP_ID),
      record: {
        name: { value: data.name || '' },
        company: { value: data.company || '' },
        address: { value: data.address || '' },
        memo: { value: data.memo || '' }
      }
    },
    { headers: { 'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN } }
  );
}

// =======================
// WEBHOOK
// =======================
app.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    const userId = body.source?.userId;

    // ===== TEXT =====
    if (body.content?.type === 'text') {
      const originalText = body.content.text.trim();
      const text = originalText.toUpperCase();

      // モード切替
      if (text === 'AUTO') {
        userModes[userId] = 'auto';
        await sendMessage('✅ 自動登録モード');
        return;
      }

      if (text === 'MANUAL') {
        userModes[userId] = 'manual';
        await sendMessage('✅ 確認モード');
        return;
      }

      // メモ入力
      if (pendingMemo[userId]) {
        const data = pendingMemo[userId];
        data.memo = originalText;

        await register(data, userId);

        await sendMessage(`✅ 登録しました：${data.name}`);
        delete pendingMemo[userId];
        return;
      }

      // OK
      if (text === 'OK' && pendingData[userId]) {
        const data = pendingData[userId];
        delete pendingData[userId];

        pendingMemo[userId] = data;
        await sendMessage('📝 メモを入力してください（なければ「なし」）');
        return;
      }

      // NG
      if (text === 'NG') {
        delete pendingData[userId];
        await sendMessage('❌ キャンセル');
        return;
      }

      return;
    }

    // ===== IMAGE =====
    if (body.content?.type === 'image') {
      const data = {
        name: "テスト",
        company: "サンプル",
        address: "沖縄",
        memo: ""
      };

      const mode = userModes[userId] || 'manual';

      if (mode === 'auto') {
        await register(data, userId);
        await sendMessage(`✅ 自動登録：${data.name}`);
        return;
      }

      pendingData[userId] = data;

      await sendMessage(`📋 確認
名前：${data.name}
会社：${data.company}

👉 OK / NG`);
    }

  } catch (e) {
    console.error('❌ エラー:', decodeErrorBody(e.response?.data) || e.message);
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log('🚀 Server started');
});

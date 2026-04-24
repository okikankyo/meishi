const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '20mb' }));

const pendingData = {};

function decodeErrorBody(data) {
  if (!data) return '';
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (typeof data === 'string') return data;
  return JSON.stringify(data);
}

// =======================
// TOKEN
// =======================
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = (process.env.LW_PRIVATE_KEY || '').replace(/\\n/g, '\n');

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

  console.log('✅ token取得成功');
  return res.data.access_token;
}

// =======================
// SEND MESSAGE
// =======================
async function sendMessage(text) {
  const token = await getAccessToken();

  await axios.post(
    `https://www.worksapis.com/v1.0/bots/${process.env.LW_BOT_ID}/channels/${process.env.LW_TARGET_CHANNEL_ID}/messages`,
    { content: { type: 'text', text } },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );

  console.log('✅ グループ返信成功');
}

// =======================
// IMAGE FETCH
// =======================
async function fetchImageBuffer(fileId) {
  const token = await getAccessToken();

  const url = `https://www.worksapis.com/v1.0/bots/${process.env.LW_BOT_ID}/attachments/${fileId}`;

  const first = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
    maxRedirects: 0,
    validateStatus: () => true
  });

  if (first.status === 200) {
    return {
      buffer: Buffer.from(first.data),
      contentType: first.headers['content-type'] || 'image/jpeg'
    };
  }

  if (first.status === 302 && first.headers.location) {
    console.log('⚠️ 公式APIは302、storage URLで再取得');

    const second = await axios.get(first.headers.location, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer'
    });

    return {
      buffer: Buffer.from(second.data),
      contentType: second.headers['content-type'] || 'image/jpeg'
    };
  }

  throw new Error('画像取得失敗');
}

// =======================
// OCR
// =======================
async function analyzeBusinessCard(imageDataUrl) {
  const response = await axios.post(
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
"name":"",
"company":"",
"department":"",
"position":"",
"phone":"",
"mobile":"",
"email":"",
"address":"",
"memo":""
}`
            },
            {
              type: 'input_image',
              image_url: imageDataUrl
            }
          ]
        }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    }
  );

  const raw = response.data.output?.[0]?.content?.[0]?.text;

  const cleaned = raw
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();

  return JSON.parse(cleaned);
}

// =======================
// DUPLICATE
// =======================
async function checkDuplicate(data) {
  if (!data.email && !data.phone) return false;

  const query = data.email
    ? `email = "${data.email}"`
    : `phone = "${data.phone}"`;

  const res = await axios.get(
    `https://${process.env.KINTONE_SUBDOMAIN}.cybozu.com/k/v1/records.json`,
    {
      headers: { 'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN },
      params: {
        app: Number(process.env.KINTONE_APP_ID),
        query
      }
    }
  );

  return res.data.records.length > 0;
}

// =======================
// REGISTER
// =======================
async function registerBusinessCard(data) {
  const duplicated = await checkDuplicate(data);
  if (duplicated) return { duplicated: true };

  await axios.post(
    `https://${process.env.KINTONE_SUBDOMAIN}.cybozu.com/k/v1/record.json`,
    {
      app: Number(process.env.KINTONE_APP_ID),
      record: {
        name: { value: data.name || '' },
        company: { value: data.company || '' },
        department: { value: data.department || '' },
        position: { value: data.position || '' },
        phone: { value: data.phone || '' },
        mobile: { value: data.mobile || '' },
        email: { value: data.email || '' },
        address: { value: data.address || '' },
        memo: { value: data.memo || '' }
      }
    },
    {
      headers: { 'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN }
    }
  );

  console.log('✅ kintone登録完了');
  return { duplicated: false };
}

// =======================
// WEBHOOK
// =======================
app.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    const userId = body.source?.userId;

    console.log('📩 受信:', JSON.stringify(body));

    // TEXT
    if (body.type === 'message' && body.content?.type === 'text') {
      const text = body.content.text.trim().toUpperCase();

      if (text === 'OK' && pendingData[userId]) {
        const data = pendingData[userId];
        const result = await registerBusinessCard(data);

        await sendMessage(
          result.duplicated
            ? `⚠️ 既に登録済み：${data.name}`
            : `✅ 登録しました：${data.name}`
        );

        delete pendingData[userId];
        return;
      }

      if (text === 'NG' && pendingData[userId]) {
        delete pendingData[userId];
        await sendMessage('❌ キャンセルしました');
        return;
      }
    }

    // IMAGE
    if (body.content?.type !== 'image') return;

    const fileInfo = await fetchImageBuffer(body.content.fileId);

    const imageDataUrl =
      `data:${fileInfo.contentType};base64,${fileInfo.buffer.toString('base64')}`;

    const data = await analyzeBusinessCard(imageDataUrl);

    pendingData[userId] = data;

    await sendMessage(
`📋 確認

名前：${data.name}
会社：${data.company}

👉 OK / NG`
    );

  } catch (e) {
    console.error('❌ エラー:', decodeErrorBody(e.response?.data) || e.message);
    await sendMessage('❌ エラー発生');
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log('🚀 Server started');
});

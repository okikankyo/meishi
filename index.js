const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

// =======================
// LINE WORKS トークン取得
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
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  );

  return res.data.access_token;
}

// =======================
// グループ返信
// =======================
async function sendMessage(text) {
  const token = await getAccessToken();

  await axios.post(
    `https://www.worksapis.com/v1.0/bots/${process.env.LW_BOT_ID}/channels/${process.env.LW_TARGET_CHANNEL_ID}/messages`,
    {
      content: { type: 'text', text }
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// =======================
// 画像取得（attachments版）
// =======================
async function getImageDataUrl(fileId) {
  const token = await getAccessToken();

  try {
    const res = await axios.get(
      `https://www.worksapis.com/v1.0/bots/${process.env.LW_BOT_ID}/attachments/${fileId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        },
        responseType: 'arraybuffer'
      }
    );

    const contentType = res.headers['content-type'] || 'image/jpeg';
    const base64 = Buffer.from(res.data).toString('base64');

    return `data:${contentType};base64,${base64}`;

  } catch (e) {
    const body = e.response?.data
      ? Buffer.from(e.response.data).toString('utf8')
      : e.message;

    console.error('❌ 画像取得失敗:', body);
    throw e;
  }
}

// =======================
// ChatGPT OCR
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
              text: `この画像は日本の名刺です。JSON形式で抽出してください：

{
"name": "",
"company": "",
"department": "",
"position": "",
"phone": "",
"mobile": "",
"email": "",
"address": "",
"memo": ""
}

・存在しない項目は空文字
・日本語で出力
・JSONのみ返す`
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
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const text = response.data.output[0].content[0].text;
  return JSON.parse(text);
}

// =======================
// kintone登録
// =======================
async function registerBusinessCard(data) {
  const url = `https://${process.env.KINTONE_SUBDOMAIN}.cybozu.com/k/v1/record.json`;

  await axios.post(
    url,
    {
      app: process.env.KINTONE_APP_ID,
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
      headers: {
        'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN
      }
    }
  );

  console.log('✅ kintone登録完了');
}

// =======================
// Webhook
// =======================
app.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    console.log('📩 受信:', JSON.stringify(req.body));

    if (req.body.type !== 'message') return;
    if (req.body.content?.type !== 'image') {
      console.log('⏭ 画像以外スキップ');
      return;
    }

    const fileId = req.body.content.fileId;

    const imageDataUrl = await getImageDataUrl(fileId);
    const data = await analyzeBusinessCard(imageDataUrl);

    console.log('🧠 解析結果:', data);

    await registerBusinessCard(data);

    await sendMessage(`✅ 名刺登録しました：${data.name || '名前不明'}`);

  } catch (e) {
    const body = e.response?.data
      ? (Buffer.isBuffer(e.response.data)
          ? Buffer.from(e.response.data).toString('utf8')
          : JSON.stringify(e.response.data))
      : e.message;

    console.error('❌ エラー:', body);

    try {
      await sendMessage('❌ 名刺登録に失敗しました');
    } catch (e2) {
      console.error('❌ 通知失敗:', e2.message);
    }
  }
});

// =======================
// 起動（1つだけ）
// =======================
app.get('/', (req, res) => {
  res.send('名刺管理くん稼働中');
});

app.listen(process.env.PORT || 10000, () => {
  console.log('🚀 Server started');
});

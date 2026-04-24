const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '20mb' }));

const pendingData = {};

// =======================
// 共通
// =======================
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
  params.append('scope', 'bot bot.message user.read');

  const res = await axios.post(
    'https://auth.worksmobile.com/oauth2/v2.0/token',
    params,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  console.log('✅ token取得成功');
  return res.data.access_token;
}

// =======================
// LINE WORKSユーザー名取得
// =======================
async function getLineUserName(userId) {
  try {
    const token = await getAccessToken();
    const res = await axios.get(
      `https://www.worksapis.com/v1.0/users/${userId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return res.data.userName || res.data.displayName || userId;
  } catch {
    return userId;
  }
}

// =======================
// メッセージ送信
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
// 画像取得
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
      contentType: first.headers['content-type']
    };
  }

  if (first.status === 302) {
    const second = await axios.get(first.headers.location, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer'
    });

    return {
      buffer: Buffer.from(second.data),
      contentType: second.headers['content-type']
    };
  }

  throw new Error('画像取得失敗');
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
              text: `名刺情報をJSONで抽出

{
"name":"",
"company":"",
"department":"",
"position":"",
"phone":"",
"mobile":"",
"fax":"",
"email":"",
"address":"",
"memo":""
}

・住所はaddress
・FAXはfax
・FAXやURLはmemoに入れない
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
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    }
  );

  const raw = res.data.output[0].content[0].text;

  const cleaned = raw
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();

  return JSON.parse(cleaned);
}

// =======================
// kintone ファイルアップロード
// =======================
async function uploadFile(buffer) {
  const form = new FormData();
  const blob = new Blob([buffer]);

  form.append('file', blob, 'meishi.jpg');

  const res = await fetch(
    `https://${process.env.KINTONE_SUBDOMAIN}.cybozu.com/k/v1/file.json`,
    {
      method: 'POST',
      headers: {
        'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN
      },
      body: form
    }
  );

  const json = await res.json();
  return json.fileKey;
}

// =======================
// 登録
// =======================
async function register(data, userId) {
  const ownerName = await getLineUserName(userId);

  const record = {
    name: { value: data.name },
    company: { value: data.company },
    department: { value: data.department },
    position: { value: data.position },
    phone: { value: data.phone },
    mobile: { value: data.mobile },
    email: { value: data.email },
    address: { value: data.address },
    memo: { value: data.memo }
  };

  // FAX
  if (process.env.KINTONE_FAX_FIELD_CODE) {
    record[process.env.KINTONE_FAX_FIELD_CODE] = {
      value: data.fax || ''
    };
  }

  // 担当者
  if (process.env.KINTONE_OWNER_FIELD_CODE) {
    record[process.env.KINTONE_OWNER_FIELD_CODE] = {
      value: ownerName
    };
  }

  // 画像
  if (process.env.KINTONE_FILE_FIELD_CODE && data._buffer) {
    const fileKey = await uploadFile(data._buffer);

    record[process.env.KINTONE_FILE_FIELD_CODE] = {
      value: [{ fileKey }]
    };
  }

  await axios.post(
    `https://${process.env.KINTONE_SUBDOMAIN}.cybozu.com/k/v1/record.json`,
    {
      app: Number(process.env.KINTONE_APP_ID),
      record
    },
    {
      headers: {
        'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN
      }
    }
  );

  console.log('✅ 登録完了');
}

// =======================
// Webhook
// =======================
app.post('/', async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  const userId = body.source?.userId;

  console.log('📩 受信:', JSON.stringify(body));

  // OK処理
  if (body.content?.type === 'text') {
    const text = body.content.text.trim().toUpperCase();

    if (text === 'OK' && pendingData[userId]) {
      await register(pendingData[userId], userId);
      await sendMessage('✅ 登録しました');
      delete pendingData[userId];
      return;
    }

    if (text === 'NG') {
      delete pendingData[userId];
      await sendMessage('❌ キャンセルしました');
      return;
    }
  }

  // 画像処理
  if (body.content?.type === 'image') {
    const file = await fetchImageBuffer(body.content.fileId);

    const imageDataUrl =
      `data:${file.contentType};base64,${file.buffer.toString('base64')}`;

    const data = await analyzeBusinessCard(imageDataUrl);

    data._buffer = file.buffer;
    pendingData[userId] = data;

    await sendMessage(
`📋 確認
名前：${data.name}
会社：${data.company}
FAX：${data.fax}
住所：${data.address}

👉 OK / NG`
    );
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log('🚀 Server started');
});

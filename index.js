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
// LINE WORKS TOKEN
// =======================
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = (process.env.LW_PRIVATE_KEY || '')
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\\n/g, '\n')
    .trim();

  console.log('LW_CLIENT_ID exists:', !!process.env.LW_CLIENT_ID);
  console.log('LW_CLIENT_SECRET exists:', !!process.env.LW_CLIENT_SECRET);
  console.log('LW_SERVICE_ACCOUNT exists:', !!process.env.LW_SERVICE_ACCOUNT);
  console.log('LW_BOT_ID exists:', !!process.env.LW_BOT_ID);
  console.log('PRIVATE_KEY header ok:', privateKey.includes('BEGIN PRIVATE KEY'));
  console.log('PRIVATE_KEY footer ok:', privateKey.includes('END PRIVATE KEY'));

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

  // user.read は入れない。まず安定優先。
  params.append('scope', 'bot bot.message');

  try {
    const res = await axios.post(
      'https://auth.worksmobile.com/oauth2/v2.0/token',
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    console.log('✅ token取得成功');
    return res.data.access_token;
  } catch (e) {
    console.error('❌ token取得失敗:', e.response?.data || e.message);
    throw e;
  }
}

// =======================
// LINE WORKS SEND
// =======================
async function sendMessage(text) {
  const token = await getAccessToken();

  await axios.post(
    `https://www.worksapis.com/v1.0/bots/${process.env.LW_BOT_ID}/channels/${process.env.LW_TARGET_CHANNEL_ID}/messages`,
    {
      content: {
        type: 'text',
        text
      }
    },
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
    console.log('✅ 公式APIで画像取得成功');
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

    console.log('✅ storage URLで画像取得成功');

    return {
      buffer: Buffer.from(second.data),
      contentType: second.headers['content-type'] || 'image/jpeg'
    };
  }

  throw new Error(`画像取得失敗: status=${first.status} body=${decodeErrorBody(first.data)}`);
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
              text: `この画像は日本の名刺です。以下のJSONのみ返してください。

{
  "name": "",
  "company": "",
  "department": "",
  "position": "",
  "phone": "",
  "mobile": "",
  "fax": "",
  "email": "",
  "address": "",
  "memo": ""
}

ルール:
・住所は必ず address
・FAXは必ず fax
・FAXやURLは memo に入れない
・memo は人物や会社の簡単な説明だけ
・存在しない項目は空文字
・コードブロック不要`
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

  const raw = res.data.output?.[0]?.content?.[0]?.text || '';

  const cleaned = raw
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();

  return JSON.parse(cleaned);
}

// =======================
// KINTONE FILE UPLOAD
// =======================
async function uploadFile(buffer, contentType) {
  const form = new FormData();
  const blob = new Blob([buffer], { type: contentType || 'image/jpeg' });

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

  if (!res.ok) {
    throw new Error(`kintoneファイルアップロード失敗: ${JSON.stringify(json)}`);
  }

  console.log('✅ kintoneファイルアップロード成功:', json.fileKey);
  return json.fileKey;
}

// =======================
// DUPLICATE CHECK
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
async function register(data, userId) {
  const duplicated = await checkDuplicate(data);
  if (duplicated) return { duplicated: true };

  const record = {
    name: { value: data.name || '' },
    company: { value: data.company || '' },
    department: { value: data.department || '' },
    position: { value: data.position || '' },
    phone: { value: data.phone || '' },
    mobile: { value: data.mobile || '' },
    email: { value: data.email || '' },
    address: { value: data.address || '' },
    memo: { value: data.memo || '' }
  };

  // FAXフィールド
  if (process.env.KINTONE_FAX_FIELD_CODE) {
    record[process.env.KINTONE_FAX_FIELD_CODE] = {
      value: data.fax || ''
    };
  }

  // ownerフィールド
  // LINE WORKSの名前取得は一旦せず、ENV指定があればそれを入れる。なければuserId。
  if (process.env.KINTONE_OWNER_FIELD_CODE) {
    record[process.env.KINTONE_OWNER_FIELD_CODE] = {
      value: process.env.KINTONE_OWNER_VALUE || userId || ''
    };
  }

  // 名刺画像フィールド
  if (process.env.KINTONE_FILE_FIELD_CODE && data._buffer) {
    const fileKey = await uploadFile(data._buffer, data._contentType);

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
        'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN,
        'Content-Type': 'application/json'
      }
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

    // OK / NG
    if (body.type === 'message' && body.content?.type === 'text') {
      const text = body.content.text.trim().toUpperCase();

      if (text === 'OK' && pendingData[userId]) {
        const data = pendingData[userId];
        const result = await register(data, userId);

        await sendMessage(
          result.duplicated
            ? `⚠️ 既に登録済み：${data.name || '名前不明'}`
            : `✅ 登録しました：${data.name || '名前不明'}`
        );

        delete pendingData[userId];
        return;
      }

      if (text === 'NG' && pendingData[userId]) {
        delete pendingData[userId];
        await sendMessage('❌ キャンセルしました');
        return;
      }

      return;
    }

    // 画像
    if (body.type !== 'message') return;
    if (body.content?.type !== 'image') return;

    const fileInfo = await fetchImageBuffer(body.content.fileId);

    console.log(`✅ 画像取得成功: ${fileInfo.buffer.length} bytes`);

    const imageDataUrl =
      `data:${fileInfo.contentType};base64,${fileInfo.buffer.toString('base64')}`;

    const data = await analyzeBusinessCard(imageDataUrl);

    data._buffer = fileInfo.buffer;
    data._contentType = fileInfo.contentType;

    pendingData[userId] = data;

    await sendMessage(
`📋 確認

名前：${data.name || ''}
会社：${data.company || ''}
部署：${data.department || ''}
役職：${data.position || ''}
電話：${data.phone || ''}
携帯：${data.mobile || ''}
FAX：${data.fax || ''}
メール：${data.email || ''}
住所：${data.address || ''}
メモ：${data.memo || ''}

👉 OK / NG`
    );

  } catch (e) {
    console.error('❌ エラー:', e.response?.data || e.message);

    try {
      await sendMessage('❌ エラー発生');
    } catch (e2) {
      console.error('❌ エラー通知失敗:', e2.response?.data || e2.message);
    }
  }
});

// =======================
// HEALTH CHECK
// =======================
app.get('/', (req, res) => {
  res.send('名刺管理くん稼働中');
});

app.listen(process.env.PORT || 10000, () => {
  console.log('🚀 Server started');
});

const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '20mb' }));

// =======================
// 一時保存（OK待ち）
// =======================
const pendingData = {}; // userId単位で保持

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
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
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
    { content: { type: 'text', text } },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// =======================
// 画像取得（公式→storageフォールバック）
// =======================
async function fetchImageBuffer(fileId) {
  const token = await getAccessToken();

  const officialUrl =
    `https://www.worksapis.com/v1.0/bots/${process.env.LW_BOT_ID}/attachments/${fileId}`;

  try {
    const first = await axios.get(officialUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      maxRedirects: 0,
      validateStatus: () => true
    });

    // 直接200
    if (first.status === 200) {
      return {
        buffer: Buffer.from(first.data),
        contentType: first.headers['content-type'] || 'image/jpeg'
      };
    }

    // 302 → storage URLへ
    if (first.status === 302 && first.headers.location) {
      const second = await axios.get(first.headers.location, {
        responseType: 'arraybuffer'
      });

      return {
        buffer: Buffer.from(second.data),
        contentType: second.headers['content-type'] || 'image/jpeg'
      };
    }

    throw new Error(
      `画像取得失敗: status=${first.status} body=${decodeErrorBody(first.data)}`
    );
  } catch (e) {
    const body = decodeErrorBody(e.response?.data) || e.message;
    console.error('❌ 画像取得失敗:', body);
    throw e;
  }
}

async function getImageDataUrl(fileId) {
  const { buffer, contentType } = await fetchImageBuffer(fileId);
  return `data:${contentType};base64,${buffer.toString('base64')}`;
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
              text: `この画像は日本の名刺です。JSON形式で抽出してください。

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

・会社名は正式名称
・電話と携帯は分ける
・memoは1行説明
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

  const text = response.data.output?.[0]?.content?.[0]?.text;
  return JSON.parse(text);
}

// =======================
// 重複チェック（メール優先）
// =======================
async function checkDuplicate(data) {
  const url = `https://${process.env.KINTONE_SUBDOMAIN}.cybozu.com/k/v1/records.json`;

  let query = '';
  if (data.email) query = `email = "${data.email}"`;
  else if (data.phone) query = `phone = "${data.phone}"`;
  else return false;

  const res = await axios.get(url, {
    headers: { 'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN },
    params: {
      app: Number(process.env.KINTONE_APP_ID),
      query
    }
  });

  return res.data.records.length > 0;
}

// =======================
// kintone登録
// =======================
async function registerBusinessCard(data) {
  const duplicated = await checkDuplicate(data);
  if (duplicated) return { duplicated: true };

  const url = `https://${process.env.KINTONE_SUBDOMAIN}.cybozu.com/k/v1/record.json`;

  await axios.post(
    url,
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
      headers: {
        'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN,
        'Content-Type': 'application/json'
      }
    }
  );

  return { duplicated: false };
}

// =======================
// Webhook（OKフロー）
// =======================
app.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    const userId = body.source?.userId;

    // ===== テキスト（OK / NG）=====
    if (body.type === 'message' && body.content?.type === 'text') {
      const text = body.content.text;

      // OK登録
      if (text === 'OK' && pendingData[userId]) {
        const data = pendingData[userId];

        const result = await registerBusinessCard(data);

        if (result.duplicated) {
          await sendMessage(`⚠️ 既に登録済み：${data.name}`);
        } else {
          await sendMessage(`✅ 登録しました：${data.name}`);
        }

        delete pendingData[userId];
        return;
      }

      // NGキャンセル
      if (text === 'NG' && pendingData[userId]) {
        delete pendingData[userId];
        await sendMessage('❌ 登録キャンセルしました');
        return;
      }
    }

    // ===== 画像受信 =====
    if (body.type !== 'message') return;
    if (body.content?.type !== 'image') return;

    const fileId = body.content.fileId;

    const imageDataUrl = await getImageDataUrl(fileId);
    const data = await analyzeBusinessCard(imageDataUrl);

    // 一時保存
    pendingData[userId] = data;

    // 確認表示
    await sendMessage(
`📋 内容確認

名前：${data.name}
会社：${data.company}
部署：${data.department}
メール：${data.email}

👉 OK で登録 / NG でキャンセル`
    );

  } catch (e) {
    const body = decodeErrorBody(e.response?.data) || e.message;
    console.error('❌ エラー:', body);
    await sendMessage('❌ 処理中にエラーが発生しました');
  }
});

// =======================
// 起動
// =======================
app.get('/', (req, res) => {
  res.send('名刺管理くん稼働中');
});

app.listen(process.env.PORT || 10000, () => {
  console.log('🚀 Server started');
});

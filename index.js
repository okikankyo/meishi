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

async function fetchImageBuffer(fileId) {
  const token = await getAccessToken();

  const officialUrl =
    `https://www.worksapis.com/v1.0/bots/${process.env.LW_BOT_ID}/attachments/${fileId}`;

  const first = await axios.get(officialUrl, {
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
      responseType: 'arraybuffer'
    });

    console.log('✅ storage URLで画像取得成功');
    return {
      buffer: Buffer.from(second.data),
      contentType: second.headers['content-type'] || 'image/jpeg'
    };
  }

  throw new Error(
    `画像取得失敗: status=${first.status} body=${decodeErrorBody(first.data)}`
  );
}

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

ルール:
・存在しない項目は空文字
・会社名は正式名称
・電話と携帯は分ける
・memo は1行で簡単な人物説明
・余計な説明は不要
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
  if (!text) throw new Error('OpenAIの応答からJSONを取得できませんでした');

  return JSON.parse(text);
}

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

  console.log('✅ kintone登録完了');
  return { duplicated: false };
}

app.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    const userId = body.source?.userId;

    console.log('📩 受信:', JSON.stringify(body));

    if (body.type === 'message' && body.content?.type === 'text') {
      const text = body.content.text.trim();

      if (text === 'OK' && pendingData[userId]) {
        const data = pendingData[userId];
        const result = await registerBusinessCard(data);

        if (result.duplicated) {
          await sendMessage(`⚠️ 既に登録済みの可能性があります：${data.name || '名前不明'}`);
        } else {
          await sendMessage(`✅ 登録しました：${data.name || '名前不明'}`);
        }

        delete pendingData[userId];
        return;
      }

      if (text === 'NG' && pendingData[userId]) {
        delete pendingData[userId];
        await sendMessage('❌ 登録キャンセルしました');
        return;
      }

      return;
    }

    if (body.type !== 'message') return;
    if (body.content?.type !== 'image') {
      console.log('⏭ 画像以外スキップ');
      return;
    }

    const fileId = body.content.fileId;
    if (!fileId) throw new Error('fileId がありません');

    const fileInfo = await fetchImageBuffer(fileId);
    console.log(`✅ 画像取得成功: ${fileInfo.buffer.length} bytes`);

    const imageDataUrl =
      `data:${fileInfo.contentType};base64,${fileInfo.buffer.toString('base64')}`;

    const data = await analyzeBusinessCard(imageDataUrl);
    console.log('🧠 解析結果:', data);

    pendingData[userId] = data;

    await sendMessage(
`📋 内容確認

名前：${data.name || ''}
会社：${data.company || ''}
部署：${data.department || ''}
役職：${data.position || ''}
電話：${data.phone || ''}
携帯：${data.mobile || ''}
メール：${data.email || ''}
住所：${data.address || ''}
メモ：${data.memo || ''}

👉 OK で登録 / NG でキャンセル`
    );

  } catch (e) {
    const body = decodeErrorBody(e.response?.data) || e.message;
    console.error('❌ エラー:', body);

    try {
      await sendMessage('❌ 処理中にエラーが発生しました');
    } catch (e2) {
      console.error('❌ 通知失敗:', e2.message);
    }
  }
});

app.get('/', (req, res) => {
  res.send('名刺管理くん稼働中');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('🚀 Server started');
});

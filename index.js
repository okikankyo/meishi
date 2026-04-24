const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '20mb' }));

const pendingData = {};
const pendingMemo = {};
const userModes = {};

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
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
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
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    }
  );

  const raw = res.data.output?.[0]?.content?.[0]?.text || '';
  const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();

  return JSON.parse(cleaned);
}

// =======================
// 重複チェック（止めない）
// =======================
async function checkDuplicate(data) {
  const conditions = [];

  if (data.email) {
    conditions.push(`email = "${escapeKintoneQueryValue(data.email)}"`);
  }

  if (data.mobile) {
    conditions.push(`mobile = "${escapeKintoneQueryValue(data.mobile)}"`);
  }

  if (data.phone) {
    conditions.push(`phone = "${escapeKintoneQueryValue(data.phone)}"`);
  }

  if (data.name && data.company) {
    conditions.push(
      `(name = "${escapeKintoneQueryValue(data.name)}" and company = "${escapeKintoneQueryValue(data.company)}")`
    );
  }

  if (!conditions.length) {
    return { duplicated: false };
  }

  const query = `${conditions.join(' or ')} limit 1`;

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

  return { duplicated: res.data.records.length > 0 };
}

// =======================
// 登録
// =======================
async function register(data, userId) {
  const duplicate = await checkDuplicate(data);

  const record = {
    name: { value: data.name || '' },
    company: { value: data.company || '' },
    address: { value: data.address || '' },
    memo: { value: data.memo || '' }
  };

  // ★ここが修正ポイント
  if (process.env.KINTONE_DUPLICATE_FLAG_CODE) {
    record[process.env.KINTONE_DUPLICATE_FLAG_CODE] = {
      value: duplicate.duplicated ? ['重複候補'] : []
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

  return duplicate;
}

// =======================
// MAIN
// =======================
app.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    const userId = body.source?.userId;

    console.log('📩 受信:', JSON.stringify(body));

    // ===== TEXT =====
    if (body.content?.type === 'text') {
      const originalText = body.content.text.trim();
      const text = originalText.toUpperCase();

      if (text === 'AUTO') {
        userModes[userId] = 'auto';
        await sendMessage('自動登録モード');
        return;
      }

      if (text === 'MANUAL') {
        userModes[userId] = 'manual';
        await sendMessage('確認モード');
        return;
      }

      if (pendingMemo[userId]) {
        const data = pendingMemo[userId];
        if (text !== 'なし') data.memo = originalText;

        const result = await register(data, userId);

        await sendMessage(
          result.duplicated
            ? `登録（重複候補）`
            : `登録完了`
        );

        delete pendingMemo[userId];
        return;
      }

      if (text === 'OK' && pendingData[userId]) {
        pendingMemo[userId] = pendingData[userId];
        delete pendingData[userId];

        await sendMessage('メモ入力してください（なければ「なし」）');
        return;
      }

      if (text === 'NG') {
        delete pendingData[userId];
        await sendMessage('キャンセル');
        return;
      }

      return;
    }

    // ===== IMAGE =====
    if (body.content?.type === 'image') {
      const data = {
        name: "テスト",
        company: "会社",
        address: "沖縄",
        memo: ""
      };

      const mode = userModes[userId] || 'manual';

      if (mode === 'auto') {
        const result = await register(data, userId);

        await sendMessage(
          result.duplicated
            ? `自動登録（重複候補）`
            : `自動登録完了`
        );

        return;
      }

      pendingData[userId] = data;

      await sendMessage(`確認→ OK / NG`);
    }

  } catch (e) {
    console.error('❌ エラー:', e.response?.data || e.message);
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log('🚀 Server started');
});

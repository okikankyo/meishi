const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '20mb' }));

const pendingData = {};
const pendingMemo = {};
const userModes = {}; // manual / auto

function decodeErrorBody(data) {
  if (!data) return '';
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (typeof data === 'string') return data;
  return JSON.stringify(data);
}

function escapeKintoneQueryValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = (process.env.LW_PRIVATE_KEY || '')
    .replace(/^"(.*)"$/s, '$1')
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
    const second = await axios.get(first.headers.location, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer'
    });

    return {
      buffer: Buffer.from(second.data),
      contentType: second.headers['content-type'] || 'image/jpeg'
    };
  }

  throw new Error(`画像取得失敗: status=${first.status} body=${decodeErrorBody(first.data)}`);
}

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

  return json.fileKey;
}

// =======================
// 重複候補チェック
// 登録は止めない。フラグ用に情報だけ返す。
// =======================
async function checkDuplicateCandidate(data) {
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
    return {
      duplicated: false,
      note: ''
    };
  }

  const query = `${conditions.join(' or ')} order by $id desc limit 1`;

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

  if (res.data.records.length === 0) {
    return {
      duplicated: false,
      note: ''
    };
  }

  const r = res.data.records[0];

  return {
    duplicated: true,
    note:
`重複候補あり
既存ID：${r.$id?.value || ''}
既存名前：${r.name?.value || ''}
既存会社：${r.company?.value || ''}
既存部署：${r.department?.value || ''}
既存メール：${r.email?.value || ''}
既存電話：${r.phone?.value || ''}
既存携帯：${r.mobile?.value || ''}`
  };
}

async function searchBusinessCards(keyword) {
  const safe = escapeKintoneQueryValue(keyword);

  const query = `
    name like "${safe}" or
    company like "${safe}" or
    department like "${safe}" or
    email like "${safe}" or
    phone like "${safe}" or
    mobile like "${safe}"
    order by $id desc
    limit 5
  `;

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

  return res.data.records;
}

function buildSearchResultMessage(records, keyword) {
  if (!records.length) {
    return `🔍「${keyword}」は見つかりませんでした`;
  }

  const faxCode = process.env.KINTONE_FAX_FIELD_CODE || 'fax';

  let msg = `🔍 名刺検索結果：「${keyword}」\n\n`;

  records.forEach((r, index) => {
    msg += `【${index + 1}】\n`;
    msg += `名前：${r.name?.value || ''}\n`;
    msg += `会社：${r.company?.value || ''}\n`;
    msg += `部署：${r.department?.value || ''}\n`;
    msg += `役職：${r.position?.value || ''}\n`;
    msg += `電話：${r.phone?.value || ''}\n`;
    msg += `携帯：${r.mobile?.value || ''}\n`;
    msg += `FAX：${r[faxCode]?.value || ''}\n`;
    msg += `メール：${r.email?.value || ''}\n`;
    msg += `住所：${r.address?.value || ''}\n\n`;
  });

  return msg.trim();
}

async function register(data, userId) {
  const duplicate = await checkDuplicateCandidate(data);

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

  if (process.env.KINTONE_FAX_FIELD_CODE) {
    record[process.env.KINTONE_FAX_FIELD_CODE] = {
      value: data.fax || ''
    };
  }

  if (process.env.KINTONE_OWNER_FIELD_CODE) {
    record[process.env.KINTONE_OWNER_FIELD_CODE] = {
      value: process.env.KINTONE_OWNER_VALUE || userId || ''
    };
  }

  if (process.env.KINTONE_FILE_FIELD_CODE && data._buffer) {
    const fileKey = await uploadFile(data._buffer, data._contentType);

    record[process.env.KINTONE_FILE_FIELD_CODE] = {
      value: [{ fileKey }]
    };
  }

  // 重複フラグ
  if (process.env.KINTONE_DUPLICATE_FLAG_CODE) {
    record[process.env.KINTONE_DUPLICATE_FLAG_CODE] = {
      value: duplicate.duplicated ? ['重複候補'] : ['なし']
    };
  }

  // 重複メモ
  if (process.env.KINTONE_DUPLICATE_NOTE_CODE) {
    record[process.env.KINTONE_DUPLICATE_NOTE_CODE] = {
      value: duplicate.note || ''
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

  return {
    duplicated: duplicate.duplicated,
    note: duplicate.note
  };
}

async function handleImage(body, userId) {
  const fileInfo = await fetchImageBuffer(body.content.fileId);

  const imageDataUrl =
    `data:${fileInfo.contentType};base64,${fileInfo.buffer.toString('base64')}`;

  const data = await analyzeBusinessCard(imageDataUrl);

  data._buffer = fileInfo.buffer;
  data._contentType = fileInfo.contentType;

  const mode = userModes[userId] || 'manual';

  if (mode === 'auto') {
    const result = await register(data, userId);

    await sendMessage(
      result.duplicated
        ? `✅ 自動登録しました：${data.name || '名前不明'}\n⚠️ 重複候補として登録しました`
        : `✅ 自動登録しました：${data.name || '名前不明'}`
    );

    return;
  }

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

👉 OK / NG

※自動登録にする場合は「auto」
※確認モードに戻す場合は「manual」`
  );
}

app.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    const userId = body.source?.userId;

    console.log('📩 受信:', JSON.stringify(body));

    if (body.type === 'message' && body.content?.type === 'text') {
      const originalText = body.content.text.trim();
      const text = originalText.toUpperCase();

      if (text === 'AUTO') {
        userModes[userId] = 'auto';
        await sendMessage('✅ 自動登録モードにしました。名刺画像を送ると確認なしで登録します。');
        return;
      }

      if (text === 'MANUAL') {
        userModes[userId] = 'manual';
        await sendMessage('✅ 確認モードにしました。名刺画像を送るとOK/NG確認します。');
        return;
      }

      if (text === 'OK' && pendingData[userId]) {
        const data = pendingData[userId];
        pendingMemo[userId] = data;
        delete pendingData[userId];

        await sendMessage('📝 追加メモを入力してください。なければ「なし」と送ってください。');
        return;
      }

      if (pendingMemo[userId]) {
        const data = pendingMemo[userId];

        if (text !== 'なし' && text !== 'ナシ' && text !== 'NONE') {
          data.memo = originalText;
        }

        const result = await register(data, userId);

        await sendMessage(
          result.duplicated
            ? `✅ 登録しました：${data.name || '名前不明'}\n⚠️ 重複候補として登録しました`
            : `✅ 登録しました：${data.name || '名前不明'}`
        );

        delete pendingMemo[userId];
        return;
      }

      if (text === 'NG' && pendingData[userId]) {
        delete pendingData[userId];
        await sendMessage('❌ キャンセルしました');
        return;
      }

      const records = await searchBusinessCards(originalText);
      await sendMessage(buildSearchResultMessage(records, originalText));
      return;
    }

    if (body.type !== 'message') return;
    if (body.content?.type !== 'image') return;

    await handleImage(body, userId);

  } catch (e) {
    console.error('❌ エラー:', e.response?.data || e.message);

    try {
      await sendMessage('❌ エラー発生');
    } catch (e2) {
      console.error('❌ エラー通知失敗:', e2.response?.data || e2.message);
    }
  }
});

app.get('/', (req, res) => {
  res.send('名刺管理くん稼働中');
});

app.listen(process.env.PORT || 10000, () => {
  console.log('🚀 Server started');
});

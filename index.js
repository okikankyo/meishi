const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '20mb' }));

const pendingData = {};
const pendingMemo = {};
const userModes = {};

function decodeErrorBody(data) {
  if (!data) return '';
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (typeof data === 'string') return data;
  return JSON.stringify(data);
}

function escapeKintoneQueryValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function cleanKey(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .trim();
}

function buildDuplicateKey(data) {
  const company = cleanKey(data.company);
  const name = cleanKey(data.name);
  if (!company && !name) return '';
  return `${company}_${name}`;
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

  const assertion = jwt.sign(payload, privateKey, {
    algorithm: 'RS256'
  });

  const params = new URLSearchParams();
  params.append('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  params.append('client_id', process.env.LW_CLIENT_ID);
  params.append('client_secret', process.env.LW_CLIENT_SECRET);
  params.append('assertion', assertion);
  params.append('scope', 'bot bot.message user.profile.read');

  const res = await axios.post(
    'https://auth.worksmobile.com/oauth2/v2.0/token',
    params,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );

  return res.data.access_token;
}

async function getLineWorksUserName(userId) {
  try {
    const token = await getAccessToken();

    const res = await axios.get(
      `https://www.worksapis.com/v1.0/users/${userId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const userName = res.data.userName;

    if (userName?.lastName || userName?.firstName) {
      return `${userName.lastName || ''}${userName.firstName || ''}`;
    }

    return res.data.displayName || res.data.email || userId;
  } catch (e) {
    console.error('LINE WORKSユーザー取得失敗:', e.response?.data || e.message);
    return userId;
  }
}

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
}

async function fetchImageBuffer(fileId) {
  const token = await getAccessToken();

  const url =
    `https://www.worksapis.com/v1.0/bots/${process.env.LW_BOT_ID}/attachments/${fileId}`;

  const first = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`
    },
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
      headers: {
        Authorization: `Bearer ${token}`
      },
      responseType: 'arraybuffer'
    });

    return {
      buffer: Buffer.from(second.data),
      contentType: second.headers['content-type'] || 'image/jpeg'
    };
  }

  throw new Error(`画像取得失敗: ${first.status}`);
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
              text: `この画像は日本の名刺です。以下JSONのみ返してください。
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
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const raw = res.data.output?.[0]?.content?.[0]?.text || '';

  return JSON.parse(
    raw.replace(/```json/g, '').replace(/```/g, '').trim()
  );
}

async function uploadFile(buffer, contentType) {
  const form = new FormData();
  const blob = new Blob([buffer], {
    type: contentType || 'image/jpeg'
  });

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
    throw new Error(JSON.stringify(json));
  }

  return json.fileKey;
}

async function checkDuplicateCandidate(data) {
  const conditions = [];

  if (data.email) conditions.push(`email = "${escapeKintoneQueryValue(data.email)}"`);
  if (data.mobile) conditions.push(`mobile = "${escapeKintoneQueryValue(data.mobile)}"`);
  if (data.phone) conditions.push(`phone = "${escapeKintoneQueryValue(data.phone)}"`);

  if (data.name && data.company) {
    conditions.push(
      `(name = "${escapeKintoneQueryValue(data.name)}" and company = "${escapeKintoneQueryValue(data.company)}")`
    );
  }

  if (!conditions.length) return { duplicated: false, note: '' };

  const res = await axios.get(
    `https://${process.env.KINTONE_SUBDOMAIN}.cybozu.com/k/v1/records.json`,
    {
      headers: {
        'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN
      },
      params: {
        app: Number(process.env.KINTONE_APP_ID),
        query: `${conditions.join(' or ')} order by $id desc limit 1`
      }
    }
  );

  if (!res.data.records.length) {
    return { duplicated: false, note: '' };
  }

  const r = res.data.records[0];

  return {
    duplicated: true,
    note:
`重複候補あり
既存ID：${r.$id?.value || ''}
既存名前：${r.name?.value || ''}
既存会社：${r.company?.value || ''}`
  };
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
    const ownerName = await getLineWorksUserName(userId);

    record[process.env.KINTONE_OWNER_FIELD_CODE] = {
      value: ownerName
    };
  }

  if (process.env.KINTONE_FILE_FIELD_CODE && data._buffer) {
    const fileKey = await uploadFile(data._buffer, data._contentType);

    record[process.env.KINTONE_FILE_FIELD_CODE] = {
      value: [{ fileKey }]
    };
  }

  if (process.env.KINTONE_DUPLICATE_FLAG_CODE) {
    record[process.env.KINTONE_DUPLICATE_FLAG_CODE] = {
      value: duplicate.duplicated ? ['重複候補'] : []
    };
  }

  if (process.env.KINTONE_DUPLICATE_NOTE_CODE) {
    record[process.env.KINTONE_DUPLICATE_NOTE_CODE] = {
      value: duplicate.note || ''
    };
  }

  const duplicateKeyCode =
    process.env.KINTONE_DUPLICATE_KEY_CODE || 'duplicate_key';

  record[duplicateKeyCode] = {
    value: buildDuplicateKey(data)
  };

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

async function searchBusinessCards(keyword) {
  const safe = escapeKintoneQueryValue(keyword);

  const query = `
name like "${safe}" or
company like "${safe}" or
department like "${safe}" or
email like "${safe}" or
phone like "${safe}" or
mobile like "${safe}" or
address like "${safe}"
order by $id desc
limit 5
`;

  const res = await axios.get(
    `https://${process.env.KINTONE_SUBDOMAIN}.cybozu.com/k/v1/records.json`,
    {
      headers: {
        'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN
      },
      params: {
        app: Number(process.env.KINTONE_APP_ID),
        query
      }
    }
  );

  return res.data.records;
}

app.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    const userId = body.source?.userId;

    if (body.type === 'message' && body.content?.type === 'text') {
      const text = body.content.text.trim();

      if (text.toLowerCase() === 'auto') {
        userModes[userId] = 'auto';
        await sendMessage('自動登録モードにしました');
        return;
      }

      if (text.toLowerCase() === 'manual') {
        userModes[userId] = 'manual';
        await sendMessage('確認モードにしました');
        return;
      }

      if (text.toUpperCase() === 'OK' && pendingData[userId]) {
        pendingMemo[userId] = pendingData[userId];
        delete pendingData[userId];
        await sendMessage('追加メモを入力してください（なければ「なし」）');
        return;
      }

      if (pendingMemo[userId]) {
        const data = pendingMemo[userId];

        if (text !== 'なし') {
          data.memo = text;
        }

        const result = await register(data, userId);

        await sendMessage(
          result.duplicated
            ? '登録しました（重複候補あり）'
            : '登録しました'
        );

        delete pendingMemo[userId];
        return;
      }

      if (text.toUpperCase() === 'NG' && pendingData[userId]) {
        delete pendingData[userId];
        await sendMessage('キャンセルしました');
        return;
      }

      const records = await searchBusinessCards(text);

      if (!records.length) {
        await sendMessage('見つかりませんでした');
        return;
      }

      let msg = '検索結果\n\n';

      records.forEach((r, i) => {
        msg += `【${i + 1}】\n`;
        msg += `${r.company?.value || ''}\n`;
        msg += `${r.name?.value || ''}\n`;
        msg += `${r.phone?.value || ''}\n\n`;
      });

      await sendMessage(msg);
      return;
    }

    if (body.type === 'message' && body.content?.type === 'image') {
      const fileInfo = await fetchImageBuffer(body.content.fileId);

      const imageDataUrl =
        `data:${fileInfo.contentType};base64,${fileInfo.buffer.toString('base64')}`;

      const data = await analyzeBusinessCard(imageDataUrl);

      data._buffer = fileInfo.buffer;
      data._contentType = fileInfo.contentType;

      if (userModes[userId] === 'auto') {
        const result = await register(data, userId);

        await sendMessage(
          result.duplicated
            ? '自動登録しました（重複候補あり）'
            : '自動登録しました'
        );

        return;
      }

      pendingData[userId] = data;

      await sendMessage(
`確認してください

会社：${data.company}
名前：${data.name}
部署：${data.department}
役職：${data.position}
電話：${data.phone}
携帯：${data.mobile}
FAX：${data.fax}
メール：${data.email}
住所：${data.address}
メモ：${data.memo}

OK / NG`
      );
    }

  } catch (e) {
    console.error('エラー:', e.response?.data || e.message);

    try {
      await sendMessage('エラーが発生しました');
    } catch {}
  }
});

app.get('/', (req, res) => {
  res.send('名刺管理くん稼働中');
});

app.listen(process.env.PORT || 10000, () => {
  console.log('🚀 Server started');
});

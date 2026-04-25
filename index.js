const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');

const app = express();
app.use(express.json());

const DATE_FIELD = process.env.KINTONE_DATE_FIELD || '日付';
const STORE_FIELD = process.env.KINTONE_STORE_FIELD || '店舗';
const SALES_FIELD = process.env.KINTONE_SALES_FIELD || '売上';

function todayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function formatYen(n) {
  return '¥' + Number(n || 0).toLocaleString();
}

function escapeKintone(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  const privateKey = (process.env.LW_PRIVATE_KEY || '')
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\\n/g, '\n')
    .trim();

  const assertion = jwt.sign(
    {
      iss: process.env.LW_CLIENT_ID,
      sub: process.env.LW_SERVICE_ACCOUNT,
      iat: now,
      exp: now + 300
    },
    privateKey,
    { algorithm: 'RS256' }
  );

  const params = new URLSearchParams();
  params.append('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  params.append('client_id', process.env.LW_CLIENT_ID);
  params.append('client_secret', process.env.LW_CLIENT_SECRET);
  params.append('assertion', assertion);
  params.append('scope', 'bot bot.message user.profile.read');

  const res = await axios.post(
    'https://auth.worksmobile.com/oauth2/v2.0/token',
    params,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return res.data.access_token;
}

async function sendMessage(channelId, text) {
  const token = await getAccessToken();

  await axios.post(
    `https://www.worksapis.com/v1.0/bots/${process.env.LW_BOT_ID}/channels/${channelId}/messages`,
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

function getTargetChannelIds() {
  return (process.env.LW_TARGET_CHANNEL_IDS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

async function broadcastMessage(text) {
  const channels = getTargetChannelIds();

  for (const channelId of channels) {
    try {
      await sendMessage(channelId, text);
      console.log('✅ 通知送信:', channelId);
    } catch (e) {
      console.error('❌ 通知失敗:', channelId, e.response?.data || e.message);
    }
  }
}

async function getStoreName(userId) {
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
    console.error('ユーザー取得失敗:', e.response?.data || e.message);
    return userId;
  }
}

async function registerSales(store, sales, date = todayJST()) {
  await axios.post(
    `https://${process.env.KINTONE_SUBDOMAIN}.cybozu.com/k/v1/record.json`,
    {
      app: Number(process.env.KINTONE_APP_ID),
      record: {
        [DATE_FIELD]: { value: date },
        [STORE_FIELD]: { value: store },
        [SALES_FIELD]: { value: Number(sales) }
      }
    },
    {
      headers: {
        'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN,
        'Content-Type': 'application/json'
      }
    }
  );
}

async function searchSales(store, start, end) {
  const query =
    `${STORE_FIELD} = "${escapeKintone(store)}" and ` +
    `${DATE_FIELD} >= "${start}" and ${DATE_FIELD} <= "${end}" ` +
    `order by ${DATE_FIELD} asc`;

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

  let total = 0;

  res.data.records.forEach(record => {
    total += Number(record[SALES_FIELD]?.value || 0);
  });

  return {
    count: res.data.records.length,
    total
  };
}

function getRangeFromText(text) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth() + 1;
  const d = jst.getUTCDate();

  const pad = n => String(n).padStart(2, '0');

  if (text === '今日') {
    const day = `${y}-${pad(m)}-${pad(d)}`;
    return { start: day, end: day };
  }

  if (text === '昨日') {
    const dt = new Date(Date.UTC(y, m - 1, d - 1));
    const day = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
    return { start: day, end: day };
  }

  if (text === '今月') {
    const start = `${y}-${pad(m)}-01`;
    const last = new Date(y, m, 0).getDate();
    const end = `${y}-${pad(m)}-${pad(last)}`;
    return { start, end };
  }

  if (text === '先月') {
    const lm = new Date(Date.UTC(y, m - 2, 1));
    const yy = lm.getUTCFullYear();
    const mm = lm.getUTCMonth() + 1;
    const last = new Date(yy, mm, 0).getDate();

    return {
      start: `${yy}-${pad(mm)}-01`,
      end: `${yy}-${pad(mm)}-${pad(last)}`
    };
  }

  const rangeMatch = text.match(/(\d{1,2})\/(\d{1,2})\s*[-〜~]\s*(\d{1,2})\/(\d{1,2})/);

  if (rangeMatch) {
    return {
      start: `${y}-${pad(rangeMatch[1])}-${pad(rangeMatch[2])}`,
      end: `${y}-${pad(rangeMatch[3])}-${pad(rangeMatch[4])}`
    };
  }

  return null;
}

app.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log('📩 受信:', JSON.stringify(body));

    if (body.type !== 'message') return;
    if (body.content?.type !== 'text') return;

    const channelId = body.source?.channelId;
    const userId = body.source?.userId;

    if (!channelId) {
      console.log('channelIdなし');
      return;
    }

    const store = await getStoreName(userId);
    const text = body.content.text.trim();
    const salesText = text.replace(/,/g, '');

    if (/^\d+$/.test(salesText)) {
      await registerSales(store, Number(salesText));

      await sendMessage(
        channelId,
        `✅ 登録しました\n店舗：${store}\n日付：${todayJST()}\n売上：${formatYen(salesText)}`
      );
      return;
    }

    const range = getRangeFromText(text);

    if (range) {
      const result = await searchSales(store, range.start, range.end);

      await sendMessage(
        channelId,
        `📊 ${store} の売上\n期間：${range.start}〜${range.end}\n件数：${result.count}件\n合計：${formatYen(result.total)}`
      );
      return;
    }

    await sendMessage(
      channelId,
`使い方：
・売上登録 → 120000
・検索 → 今日 / 昨日 / 今月 / 先月 / 4/1-4/15

※このアカウントの店舗だけ表示します。
現在の店舗：${store}`
    );

  } catch (e) {
    console.error('❌ エラー:', e.response?.data || e.message);

    try {
      const channelId = req.body?.source?.channelId;
      if (channelId) {
        await sendMessage(channelId, '❌ エラーが発生しました');
      }
    } catch {}
  }
});

app.get('/', (req, res) => {
  res.send('テナント売上BOT稼働中');
});

cron.schedule(
  '0 20 * * *',
  async () => {
    await broadcastMessage(
`📣 本日の売上を入力してください。

例：
120000

検索：
今日 / 今月 / 4/1-4/15`
    );
  },
  {
    timezone: 'Asia/Tokyo'
  }
);

app.listen(process.env.PORT || 10000, () => {
  console.log('🚀 Server started');
});

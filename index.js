const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const FormData = require("form-data");

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 10000;

// =========================
// LINE WORKS 環境変数
// =========================
const LW_CLIENT_ID = process.env.LW_CLIENT_ID;
const LW_CLIENT_SECRET = process.env.LW_CLIENT_SECRET;
const LW_SERVICE_ACCOUNT = process.env.LW_SERVICE_ACCOUNT;
const LW_PRIVATE_KEY = process.env.LW_PRIVATE_KEY;
const LW_BOT_ID = process.env.LW_BOT_ID;

// =========================
// kintone 環境変数
// =========================
const KINTONE_BASE_URL = process.env.KINTONE_BASE_URL; // 例: https://xxx.cybozu.com
const KINTONE_APP_ID = process.env.KINTONE_APP_ID;     // 例: 123
const KINTONE_API_TOKEN = process.env.KINTONE_API_TOKEN;

// =========================
// 起動時チェック
// =========================
function validateEnv() {
  const required = {
    LW_CLIENT_ID,
    LW_CLIENT_SECRET,
    LW_SERVICE_ACCOUNT,
    LW_PRIVATE_KEY,
    LW_BOT_ID,
    KINTONE_BASE_URL,
    KINTONE_APP_ID,
    KINTONE_API_TOKEN,
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`環境変数不足: ${missing.join(", ")}`);
  }
}

// =========================
// LINE WORKS Access Token取得
// =========================
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    iss: LW_CLIENT_ID,
    sub: LW_SERVICE_ACCOUNT,
    iat: now,
    exp: now + 300,
  };

  const privateKey = LW_PRIVATE_KEY.replace(/\\n/g, "\n");

  const assertion = jwt.sign(payload, privateKey, {
    algorithm: "RS256",
  });

  const tokenUrl = "https://auth.worksmobile.com/oauth2/v2.0/token";

  const form = new URLSearchParams();
  form.append("assertion", assertion);
  form.append("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  form.append("client_id", LW_CLIENT_ID);
  form.append("client_secret", LW_CLIENT_SECRET);
  form.append("scope", "bot");

  const response = await axios.post(tokenUrl, form.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeout: 30000,
  });

  return response.data.access_token;
}

// =========================
// LINE WORKS 返信
// =========================
async function sendTextMessage(token, channelId, text) {
  const url = `https://www.worksapis.com/v1.0/bots/${LW_BOT_ID}/channels/${channelId}/messages`;

  const body = {
    content: {
      type: "text",
      text,
    },
  };

  const response = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 30000,
  });

  return response.data;
}

// =========================
// 添付取得（公式API）
// =========================
async function getAttachmentInfoOfficial(token, fileId) {
  const url = `https://www.worksapis.com/v1.0/bots/${LW_BOT_ID}/attachments/${fileId}`;

  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (response.status >= 200 && response.status < 300) {
    return response.data;
  }

  const error = new Error(
    `公式添付API失敗 status=${response.status} body=${JSON.stringify(response.data)}`
  );
  error.response = response;
  throw error;
}

// =========================
// fileIdからstorage URLを作る
// =========================
function buildStorageDownloadUrl(fileId) {
  const parts = fileId.split(".");
  if (parts.length < 2) {
    throw new Error(`fileId形式不正: ${fileId}`);
  }

  const head = parts.shift();
  const rest = parts.join(".");
  return `https://apis-storage.worksmobile.com/k/emsg/r/${head}/${rest}/`;
}

// =========================
// 画像取得
// =========================
async function downloadAttachmentBuffer(token, fileId) {
  try {
    const attachmentInfo = await getAttachmentInfoOfficial(token, fileId);

    const candidateUrl =
      attachmentInfo.downloadUrl ||
      attachmentInfo.url ||
      attachmentInfo.resourceUrl ||
      attachmentInfo.href;

    if (!candidateUrl) {
      throw new Error(
        `公式API成功だがダウンロードURLなし: ${JSON.stringify(attachmentInfo)}`
      );
    }

    const fileResponse = await axios.get(candidateUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      responseType: "arraybuffer",
      timeout: 30000,
    });

    return Buffer.from(fileResponse.data);
  } catch (officialError) {
    console.log("⚠️ 公式API失敗、storage URLで再試行");
    console.log(officialError.message);

    const fallbackUrl = buildStorageDownloadUrl(fileId);

    const fileResponse = await axios.get(fallbackUrl, {
      responseType: "arraybuffer",
      timeout: 30000,
      validateStatus: () => true,
    });

    if (fileResponse.status < 200 || fileResponse.status >= 300) {
      const bodyText = Buffer.isBuffer(fileResponse.data)
        ? fileResponse.data.toString("utf8")
        : JSON.stringify(fileResponse.data);

      throw new Error(
        `storage URL取得失敗 status=${fileResponse.status} body=${bodyText}`
      );
    }

    return Buffer.from(fileResponse.data);
  }
}

// =========================
// kintoneへファイルアップロード
// =========================
async function uploadFileToKintone(buffer, filename) {
  const url = `${KINTONE_BASE_URL}/k/v1/file.json`;

  const form = new FormData();
  form.append("file", buffer, filename);

  const response = await axios.post(url, form, {
    headers: {
      "X-Cybozu-API-Token": KINTONE_API_TOKEN,
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 30000,
  });

  return response.data.fileKey;
}

// =========================
// kintoneへレコード追加
// 添付フィールドコード: cardimg
// =========================
async function addBusinessCardRecordToKintone({ fileKey }) {
  const url = `${KINTONE_BASE_URL}/k/v1/record.json`;

  const body = {
    app: Number(KINTONE_APP_ID),
    record: {
      cardimg: {
        value: [
          {
            fileKey: fileKey,
          },
        ],
      },
    },
  };

  const response = await axios.post(url, body, {
    headers: {
      "X-Cybozu-API-Token": KINTONE_API_TOKEN,
      "Content-Type": "application/json",
    },
    timeout: 30000,
  });

  return response.data;
}

// =========================
// Webhook受信
// =========================
app.post("/callback", async (req, res) => {
  try {
    console.log("📩 受信:", JSON.stringify(req.body));

    const event = req.body;

    if (!event || event.type !== "message") {
      return res.status(200).send("ignored: not message");
    }

    const source = event.source || {};
    const channelId = source.channelId;
    const content = event.content || {};

    if (content.type !== "image" || !content.fileId) {
      return res.status(200).send("ignored: not image");
    }

    const fileId = content.fileId;

    // 1. token取得
    const token = await getAccessToken();
    console.log("✅ token取得成功");

    // 2. LINE WORKSから画像取得
    const imageBuffer = await downloadAttachmentBuffer(token, fileId);
    console.log(`✅ 画像取得成功: ${imageBuffer.length} bytes`);

    // 3. kintoneへファイルアップロード
    const fileName = `${fileId}.jpg`;
    const fileKey = await uploadFileToKintone(imageBuffer, fileName);
    console.log("✅ kintone file upload成功:", fileKey);

    // 4. kintoneへレコード追加
    const result = await addBusinessCardRecordToKintone({ fileKey });
    console.log("✅ kintone登録成功:", result);

    // 5. LINE WORKSへ返信
    if (channelId) {
      try {
        await sendTextMessage(token, channelId, "名刺画像をkintoneへ登録しました。");
        console.log("✅ 返信送信成功");
      } catch (replyError) {
        console.log(
          "⚠️ 返信送信失敗:",
          replyError.response?.data || replyError.message
        );
      }
    }

    return res.status(200).json({
      ok: true,
      recordId: result.id,
      revision: result.revision,
    });
  } catch (error) {
    console.error("❌ エラー:", error.response?.data || error.message || error);
    return res.status(500).json({
      ok: false,
      error: error.response?.data || error.message || String(error),
    });
  }
});

// =========================
// ヘルスチェック
// =========================
app.get("/", (req, res) => {
  res.send("LINE WORKS × kintone bot is running.");
});

try {
  validateEnv();

  app.listen(PORT, () => {
    console.log("🚀 Server started");
    console.log(`PORT=${PORT}`);
  });
} catch (e) {
  console.error("起動失敗:", e.message);
  process.exit(1);
}

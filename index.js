const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ===== kintone登録 =====
async function registerBusinessCard(data) {
  const url = `https://${process.env.KINTONE_SUBDOMAIN}.cybozu.com/k/v1/record.json`;

  await axios.post(
    url,
    {
      app: process.env.KINTONE_APP_ID,
      record: {
        name: { value: data.name || "" },
        company: { value: data.company || "" },
        department: { value: data.department || "" },
        position: { value: data.position || "" },
        phone: { value: data.phone || "" },
        mobile: { value: data.mobile || "" },
        email: { value: data.email || "" },
        address: { value: data.address || "" },
        memo: { value: data.memo || "" }
      }
    },
    {
      headers: {
        "X-Cybozu-API-Token": process.env.KINTONE_API_TOKEN
      }
    }
  );

  console.log("✅ kintone登録完了");
}

// ===== ChatGPT OCR =====
async function analyzeBusinessCard(imageUrl) {
  const response = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `この画像は日本の名刺です。JSONで抽出してください：
{
"name":"","company":"","department":"","position":"",
"phone":"","mobile":"","email":"","address":"","memo":""
}`
            },
            {
              type: "input_image",
              image_url: imageUrl
            }
          ]
        }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  const text = response.data.output[0].content[0].text;
  return JSON.parse(text);
}

// ===== Webhook受信 =====
app.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    console.log("📩 受信:", JSON.stringify(req.body));

    if (req.body.type !== "message") return;

    // 画像チェック
    if (req.body.content?.type !== "image") {
      console.log("⏭ 画像じゃないのでスキップ");
      return;
    }

    const fileId = req.body.content.fileId;

    // ===== 画像URL取得（簡易）=====
    const imageUrl = `https://www.worksapis.com/v1.0/files/${fileId}`;

    // ===== OCR =====
    const data = await analyzeBusinessCard(imageUrl);

    console.log("🧠 解析結果:", data);

    // ===== kintone登録 =====
    await registerBusinessCard(data);

  } catch (e) {
    console.error("❌ エラー:", e.message);
  }
});

// ===== 起動 =====
app.get('/', (req, res) => {
  res.send("名刺管理くん稼働中");
});

app.listen(process.env.PORT || 10000, () => {
  console.log("🚀 Server started");
});

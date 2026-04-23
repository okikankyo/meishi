const axios = require('axios');

// ===== 名刺データ（テスト用）=====
const businessCardData = {
  name: "糸村 拓",
  company: "リコージャパン株式会社",
  department: "販売事業本部 沖縄支社 沖縄中北部営業所",
  position: "",
  phone: "098-934-5242",
  mobile: "080-4096-1424",
  email: "taku.itomura@jp.ricoh.com",
  address: "〒904-2151 沖縄県沖縄市字松本855",
  memo: "リコー沖縄支社の営業担当"
};

// ===== kintone登録処理 =====
async function registerBusinessCard(data) {
  const subdomain = process.env.KINTONE_SUBDOMAIN;
  const appId = process.env.KINTONE_APP_ID;
  const apiToken = process.env.KINTONE_API_TOKEN;

  if (!subdomain || !appId || !apiToken) {
    throw new Error("❌ 環境変数が足りない（KINTONE設定）");
  }

  const url = `https://${subdomain}.cybozu.com/k/v1/record.json`;

  try {
    const response = await axios.post(
      url,
      {
        app: appId,
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
          "X-Cybozu-API-Token": apiToken,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ 登録成功:", response.data);

  } catch (error) {
    console.error("❌ 登録失敗:", error.response?.data || error.message);
  }
}

// ===== 実行 =====
registerBusinessCard(businessCardData);

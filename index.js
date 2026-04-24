const express = require('express');

const app = express();
app.use(express.json({ limit: '20mb' }));

console.log('🔥 名刺管理くん 起動確認');

app.get('/', (req, res) => {
  console.log('GET確認');
  res.send('名刺管理くん稼働中');
});

app.post('/', (req, res) => {
  console.log('📩 受信:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.listen(process.env.PORT || 10000, () => {
  console.log('🚀 Server started');
});

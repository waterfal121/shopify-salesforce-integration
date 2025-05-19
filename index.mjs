import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import jwt from 'jsonwebtoken';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 建立函式統一產生 JWT 並換取 Salesforce Access Token
async function getSalesforceAccessToken() {
  // 讀取 RSA 私鑰
  const privateKey = fs.readFileSync('./server.key', 'utf8');

  // 建立 JWT
  const token = jwt.sign(
    {
      iss: process.env.SF_CLIENT_ID, // Salesforce 連接應用程式的 Client ID
      sub: process.env.SF_USERNAME, // Salesforce 使用者帳號
      aud: process.env.SF_LOGIN_URL, // Salesforce 登入 URL
      exp: Math.floor(Date.now() / 1000) + 3 * 60, // JWT 有效期限 3 分鐘
      scope: 'api',
    },
    privateKey,
    { algorithm: 'RS256' }
  );

  // 使用 JWT 向 Salesforce 換取 Access Token
  const authResponse = await axios.post(
    `${process.env.SF_LOGIN_URL}/services/oauth2/token`,
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: token,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return authResponse.data;
}

// ===================== JWT Bearer Flow Start =====================
app.get('/salesforce/jwt', async (req, res) => {
  try {
    const authData = await getSalesforceAccessToken();

    console.log('✅ Salesforce Access Token:', authData.access_token);
    res.send(
      `${new Date().toLocaleString()}: ✅ JWT 認證成功！請查看 console 拿到 Access Token`
    );
  } catch (error) {
    console.error(
      '❌ Salesforce JWT 認證失敗:',
      error.response?.data || error.message
    );
    res
      .status(500)
      .send(`${new Date().toLocaleString()}: ❌ Salesforce JWT 認證失敗`);
  }
});
// ===================== JWT Bearer Flow End =======================

// 測試用 JWT Bearer Flow 取得 Salesforce 資料
app.get('/test/salesforce', async (req, res) => {
  try {
    const authData = await getSalesforceAccessToken();
    const accessToken = authData.access_token;
    const instanceUrl = authData.instance_url;
    console.log('✅ Access Token:', accessToken);
    console.log('✅ Instance URL:', instanceUrl);

    // 呼叫 Salesforce REST API 取得 Account 資料
    const apiResponse = await axios.get(
      `${instanceUrl}/services/data/v60.0/sobjects/Shopify_Member__c`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    res.json(apiResponse.data);
  } catch (error) {
    console.error(
      '❌ Salesforce API 呼叫失敗:',
      error.response?.data || error.message
    );
    res
      .status(500)
      .send(`${new Date().toLocaleString()}: ❌ Salesforce API 呼叫失敗`);
  }
});

// Shopify Webhook Route
app.get('/webhook/order/created', (req, res) => {
  res.send('Hello, Shopify Webhook order!');
});

app.post('/webhook/order/created', async (req, res) => {
  try {
    const order = req.body;
    const now = new Date().toLocaleString();
    console.log(`${now}: 收到 Webhook - Order created`);
    console.log(order);
    console.log(`
      salesforce required fields:
      shopify_order_id: ${order.id},
      customer_id: ${order.customer.id},
      first_name: ${order.customer.first_name},
      last_name: ${order.customer.last_name},
      contact_email: ${order.contact_email},
      total_price: ${order.total_price},
      order_created_at: ${order.created_at},
      order_updated_at: ${order.updated_at},
      `);

    try {
      const authData = await getSalesforceAccessToken();
      const accessToken = authData.access_token;
      const instanceUrl = authData.instance_url;
      console.log('✅ Access Token:', accessToken);
      console.log('✅ Instance URL:', instanceUrl);

      // 建立 Salesforce Order Record
      await axios.post(
        `${instanceUrl}/services/data/v60.0/sobjects/Shopify_Order__c/`,
        {
          Shopify_Order_Id__c: order.id.toString(),
          Customer_Id__c: order.customer?.id?.toString() || '',
          Contact_Email__c: order.contact_email || '',
          First_Name__c: order.customer?.first_name || '',
          Last_Name__c: order.customer?.last_name || '',
          Total_Price__c: parseFloat(order.total_price) || null,
          Order_Create_At__c: order.created_at,
          Order_Update_At__c: order.updated_at,
        },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      res.status(200).send('Webhook received and Salesforce record created.');
    } catch (sfError) {
      console.error(
        '❌ Salesforce API 呼叫失敗:',
        sfError.response?.data || sfError.message
      );
      return res
        .status(500)
        .send(`${new Date().toLocaleString()}: ❌ Salesforce API 呼叫失敗`);
    }
  } catch (error) {
    console.error('Webhook 處理錯誤：', error.message);
    res.status(500).send('Server error');
  }
});

// get Shopify customers
app.get('/shopify/customers', async (req, res) => {
  try {
    const customersResponse = await axios.get(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/customers.json`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );
    const customers = customersResponse.data.customers;
    res.status(200).json(customers);
  } catch (err) {
    console.error('❌ 無法讀取 Shopify customers:', err.message);
    res.status(500).send('❌ 讀取 Shopify customers 失敗');
  }
});

// sync customers from Shopify to Salesforce
app.post('/sync/members/shopify-salesforce', async (req, res) => {
  try {
    const authData = await getSalesforceAccessToken();
    const accessToken = authData.access_token;
    const instanceUrl = authData.instance_url;

    const customersResponse = await axios.get(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/customers.json`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );

    const customers = customersResponse.data.customers;

    for (const customer of customers) {
      try {
        await axios.patch(
          `${instanceUrl}/services/data/v60.0/sobjects/Shopify_Member__c/Shopify_Customer_Id__c/${customer.id}`,
          {
            // Shopify_Customer_Id__c: customer.id.toString(),
            Email__c: customer.email || '',
            First_Name__c: customer.first_name || '',
            Last_Name__c: customer.last_name || '',
            Phone__c: customer.phone || '',
            Membership_Level__c: customer.tags || '',
          },
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        console.log(`✅ 同步成功：${customer.email}`);
      } catch (err) {
        console.error(
          `❌ 寫入失敗 (${customer.email}):`,
          err.response?.data || err.message
        );
      }
    }

    res.status(200).send(`✅ 成功同步 ${customers.length} 位會員至 Salesforce`);
  } catch (err) {
    console.error(
      '❌ 同步 Shopify 會員失敗:',
      err.response?.data || err.message
    );
    res.status(500).send('❌ 同步 Shopify 會員失敗');
  }
});

// get Salesforce Members
app.get('/salesforce/members', async (req, res) => {
  try {
    const authData = await getSalesforceAccessToken();
    const accessToken = authData.access_token;
    const instanceUrl = authData.instance_url;

    const query = `
      SELECT Id, Name, Email__c, First_Name__c, Last_Name__c, Phone__c, Shopify_Customer_Id__c, Membership_Level__c, Total_Lifetime_Spend__c, Last_Order_Date__c
      FROM Shopify_Member__c
    `;

    const result = await axios.get(
      `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    res.status(200).json(result.data.records);
  } catch (error) {
    console.error(
      '❌ 讀取 Salesforce Shopify Member 失敗:',
      error.response?.data || error.message
    );
    res.status(500).send('❌ 讀取 Salesforce Shopify Member 失敗');
  }
});

// sync customers from Salesforce to Shopify
app.post('/sync/members/salesforce-shopify', async (req, res) => {
  try {
    const { access_token, instance_url } = await getSalesforceAccessToken();

    const query = `
      SELECT Shopify_Customer_Id__c, Membership_Level__c
      FROM Shopify_Member__c
      WHERE Membership_Level__c != null
    `;

    const sfResponse = await axios.get(
      `${instance_url}/services/data/v60.0/query?q=${encodeURIComponent(
        query
      )}`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );

    const records = sfResponse.data.records;
    let updated = 0;

    for (const member of records) {
      const customerId = member.Shopify_Customer_Id__c;
      const tag = member.Membership_Level__c;

      if (!customerId || !tag) continue;

      try {
        await axios.put(
          `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/customers/${customerId}.json`,
          {
            customer: {
              id: customerId,
              tags: tag, // 若要保留原 tag 再合併，需先 GET 再組字串
            },
          },
          {
            headers: {
              'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
              'Content-Type': 'application/json',
            },
          }
        );

        console.log(`✅ 更新成功：Shopify 客戶 ${customerId} → Tag: ${tag}`);
        updated++;
      } catch (shopifyErr) {
        console.error(
          `❌ Shopify 更新失敗 (${customerId}):`,
          shopifyErr.response?.data || shopifyErr.message
        );
      }
    }

    res.status(200).send(`✅ 成功更新 ${updated} 筆 Shopify 客戶標籤`);
  } catch (err) {
    console.error('❌ 錯誤:', err.response?.data || err.message);
    res.status(500).send('❌ 同步失敗');
  }
});

app.get('/', (req, res) => {
  res.send(
    `${new Date().toLocaleString()}: Salesforce POC Server is running 🚀`
  );
});

app.listen(PORT, () => {
  console.log(
    `${new Date().toLocaleString()}: Server is running at http://localhost:${PORT}`
  );
});

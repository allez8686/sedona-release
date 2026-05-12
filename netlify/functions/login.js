const { blobGet, blobSet } = require('./lib/storage');
const crypto = require('crypto');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let email, password;
  try {
    const b = JSON.parse(event.body);
    email = b.email.trim().toLowerCase();
    password = b.password;
  } catch {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '请求格式错误' }) };
  }

  try {
    const userData = await blobGet('auth', `user_${email}`);
    if (!userData) {
      return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '账号不存在，请先注册' }) };
    }

    const user = JSON.parse(userData);
    const hash = crypto.pbkdf2Sync(password, user.salt, 100000, 64, 'sha256').toString('hex');

    if (hash !== user.hash) {
      return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '密码错误' }) };
    }

    const token = crypto.randomBytes(32).toString('hex');
    await blobSet('auth', `session_${token}`, JSON.stringify({
      userId: user.userId, email: user.email, createdAt: Date.now(),
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, token, user: { id: user.userId, email: user.email } }),
    };
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};

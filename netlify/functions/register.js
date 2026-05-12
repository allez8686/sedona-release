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

  if (!email || !password || password.length < 6) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '邮箱或密码格式不正确（密码至少6位）' }) };
  }

  try {
    const existing = await blobGet('auth', `user_${email}`).catch(() => null);
    if (existing) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '该邮箱已注册，请直接登录' }) };
    }

    const userId = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex');

    await blobSet('auth', `user_${email}`, JSON.stringify({
      userId, email, salt, hash, createdAt: new Date().toISOString(),
    }));

    const token = crypto.randomBytes(32).toString('hex');
    await blobSet('auth', `session_${token}`, JSON.stringify({
      userId, email, createdAt: Date.now(),
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, token, user: { id: userId, email } }),
    };
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};

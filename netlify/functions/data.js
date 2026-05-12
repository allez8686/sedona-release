const { blobGet, blobSet } = require('./lib/storage');

async function getUserFromToken(token) {
  if (!token) return null;
  try {
    const sessionData = await blobGet('auth', `session_${token}`);
    if (!sessionData) return null;
    return JSON.parse(sessionData);
  } catch (e) { return null; }
}

exports.handler = async (event, context) => {
  let userId, email;

  const identityUser = context.clientContext && context.clientContext.identity;
  if (identityUser && identityUser.sub) {
    userId = identityUser.sub;
    email = identityUser.email;
  } else {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token) {
      const session = await getUserFromToken(token);
      if (session && session.userId) {
        userId = session.userId;
        email = session.email;
      }
    }
  }

  if (!userId) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '请先登录' }) };
  }

  const key = `user_${userId}_entries`;

  try {
    if (event.httpMethod === 'GET') {
      const data = await blobGet('entries', key);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: data || '{"entries":{}}' };
    }
    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body);
      await blobSet('entries', key, JSON.stringify(body));
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
    }
    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
  }
};

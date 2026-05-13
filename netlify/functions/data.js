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
      const raw = await blobGet('entries', key);
      if (!raw) {
	return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: {}, _version: 0 }) };
      }
      const data = JSON.parse(raw);
      return {
	statusCode: 200,
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ entries: data.entries || {}, _version: data._version || 0 }),
      };
    }
    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body);
      const clientVersion = body._version;
      if (clientVersion == null) {
	return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '缺少 _version，请先拉取数据' }) };
      }

      let currentVersion = 0;
      let currentEntries = {};
      const raw = await blobGet('entries', key);
      if (raw) {
	try {
	  const current = JSON.parse(raw);
	  currentVersion = current._version || 0;
	  currentEntries = current.entries || {};
	} catch (e) {}
      }

      if (clientVersion !== currentVersion) {
	return {
	  statusCode: 409,
	  headers: { 'Content-Type': 'application/json' },
	  body: JSON.stringify({
	    error: '数据已被其他设备修改，请刷新后重试',
	    _version: currentVersion,
	    entries: currentEntries,
	  }),
	};
      }

      const newVersion = currentVersion + 1;
      await blobSet('entries', key, JSON.stringify({
	entries: body.entries || {},
	_version: newVersion,
      }));

      return {
	statusCode: 200,
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ ok: true, _version: newVersion }),
      };
    }
    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
  }
};

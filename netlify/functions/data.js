const { getStore } = require('@netlify/blobs');

exports.handler = async (event, context) => {
  const user = context.clientContext && context.clientContext.identity;

  if (!user || !user.sub) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: '请先登录' }),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  const userId = user.sub;
  const store = getStore({ name: 'entries', consistency: 'strong' });
  const key = `user_${userId}_entries`;

  try {
    if (event.httpMethod === 'GET') {
      const data = await store.get(key);
      return {
        statusCode: 200,
        body: data || '{"entries":{}}',
        headers: { 'Content-Type': 'application/json' },
      };
    }

    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body);
      await store.set(key, JSON.stringify(body));
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true }),
        headers: { 'Content-Type': 'application/json' },
      };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message }),
      headers: { 'Content-Type': 'application/json' },
    };
  }
};

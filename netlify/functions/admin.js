const { blobGet, blobSet } = require('./lib/storage');

const SITE_ID = '8a610647-ecc2-4678-9ef8-45927596772c';
const AUTH_TOKEN = 'nfc_kGRduNRdugW7gPBE6Cr8j6CQzzyEANZs2981';
const DEFAULT_PASSWORD = '060515';

async function getAdminPassword() {
  try {
    const data = await blobGet('auth', 'admin_config');
    if (data) {
      const config = JSON.parse(data);
      return config.password || DEFAULT_PASSWORD;
    }
  } catch (e) { /* fall through */ }
  return DEFAULT_PASSWORD;
}

async function listAllBlobs() {
  const res = await fetch(
    `https://api.netlify.com/api/v1/sites/${SITE_ID}/blobs`,
    { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } }
  );
  if (!res.ok) throw new Error(`Blob list failed: ${res.status}`);
  const data = await res.json();
  return data.blobs || [];
}

function parseBlobKey(rawKey) {
  // rawKey is URL-encoded like "auth%2Fuser_alice%40example.com"
  const decoded = decodeURIComponent(rawKey);
  const idx = decoded.indexOf('/');
  if (idx === -1) return null;
  return { store: decoded.slice(0, idx), key: decoded.slice(idx + 1) };
}

function isUserRecord(store, key) {
  return store === 'auth' && key.startsWith('user_') && key.includes('@');
}

function isSessionRecord(store, key) {
  return store === 'auth' && key.startsWith('session_');
}

function isEntryBlob(store, key) {
  return store === 'entries' && key.startsWith('user_') && key.endsWith('_entries');
}

function extractUserIdFromEntryKey(key) {
  // "user_UUID_entries" → "UUID"
  return key.slice(5, -8);
}

function calculateStreaks(entriesByDate) {
  const dates = Object.keys(entriesByDate).sort();
  if (dates.length === 0) return { current: 0, best: 0 };

  let best = 1, current = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1]);
    const curr = new Date(dates[i]);
    const diff = Math.round((curr - prev) / 86400000);
    if (diff === 1) {
      current++;
    } else {
      best = Math.max(best, current);
      current = 1;
    }
  }
  best = Math.max(best, current);

  // Check if current streak extends to today or yesterday
  const lastDate = new Date(dates[dates.length - 1]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffToToday = Math.round((today - lastDate) / 86400000);
  if (diffToToday > 1) {
    current = 0;
  }

  return { current, best };
}

// ── Handlers ──────────────────────────────────────────

async function handleOverview() {
  const blobs = await listAllBlobs();

  // Classify blobs
  const userBlobKeys = []; // { key: "user_alice@example.com" }
  const entryBlobKeys = []; // { key: "user_UUID_entries" }
  for (const blob of blobs) {
    const parsed = parseBlobKey(blob.key);
    if (!parsed) continue;
    if (isUserRecord(parsed.store, parsed.key)) {
      userBlobKeys.push(parsed.key);
    } else if (isEntryBlob(parsed.store, parsed.key)) {
      entryBlobKeys.push({ key: parsed.key, lastModified: blob.last_modified });
    }
  }

  // Fetch all user auth blobs in parallel
  const userAuthResults = await Promise.allSettled(
    userBlobKeys.map(key => blobGet('auth', key))
  );

  // Build user map: userId → { email, createdAt }
  const userMap = new Map();
  for (let i = 0; i < userBlobKeys.length; i++) {
    const result = userAuthResults[i];
    if (result.status !== 'fulfilled' || !result.value) continue;
    try {
      const user = JSON.parse(result.value);
      userMap.set(user.userId, { email: user.email, createdAt: user.createdAt });
    } catch (e) { /* skip corrupt data */ }
  }

  // Fetch all entry blobs in parallel
  const entryResults = await Promise.allSettled(
    entryBlobKeys.map(e => blobGet('entries', e.key))
  );

  // Process entries
  const userEntries = new Map(); // userId → { entries: {...} }
  for (let i = 0; i < entryBlobKeys.length; i++) {
    const result = entryResults[i];
    const userId = extractUserIdFromEntryKey(entryBlobKeys[i].key);
    if (result.status !== 'fulfilled' || !result.value) {
      userEntries.set(userId, { entries: {} });
      continue;
    }
    try {
      const data = JSON.parse(result.value);
      userEntries.set(userId, { entries: data.entries || {}, lastModified: entryBlobKeys[i].lastModified });
    } catch (e) {
      userEntries.set(userId, { entries: {} });
    }
  }

  // ── Aggregate stats ──
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const thirtyDaysAgo = new Date(now - 30 * 86400000);

  let totalEntries = 0;
  let activeUsers = 0;
  const moodTally = {};
  let totalLatestSavings = 0;
  let usersWithSavings = 0;
  let maxSavings = 0;
  let exercisedCount = 0;
  let learnedCount = 0;
  let totalEntryCount = 0;

  const userSummaries = [];

  for (const [userId, userInfo] of userMap) {
    const entryData = userEntries.get(userId) || { entries: {} };
    const entries = entryData.entries;
    const dates = Object.keys(entries).sort();
    const entryCount = dates.length;
    totalEntries += entryCount;
    totalEntryCount += entryCount;

    // Last activity
    const lastDate = dates.length > 0 ? dates[dates.length - 1] : null;

    // Active check
    if (lastDate) {
      const last = new Date(lastDate);
      if (last >= thirtyDaysAgo) activeUsers++;
    }

    // Latest savings
    let latestSavings = 0;
    if (dates.length > 0) {
      const latestEntry = entries[dates[dates.length - 1]];
      latestSavings = latestEntry.savings || 0;
      if (latestSavings > 0) {
        totalLatestSavings += latestSavings;
        usersWithSavings++;
      }
      if (latestSavings > maxSavings) maxSavings = latestSavings;
    }

    // Mood tally
    for (const date of dates) {
      const entry = entries[date];
      const mood = entry.mood || 'unknown';
      moodTally[mood] = (moodTally[mood] || 0) + 1;
      if (entry.exercised) exercisedCount++;
      if (entry.learned) learnedCount++;
    }

    userSummaries.push({
      userId,
      email: userInfo.email,
      createdAt: userInfo.createdAt,
      entryCount,
      lastActivity: lastDate,
      latestSavings,
    });
  }

  // Sort by lastActivity desc
  userSummaries.sort((a, b) => {
    if (!a.lastActivity) return 1;
    if (!b.lastActivity) return -1;
    return b.lastActivity.localeCompare(a.lastActivity);
  });

  const overview = {
    totalUsers: userMap.size,
    totalEntries,
    activeUsers,
    moodDistribution: moodTally,
    savingsStats: {
      average: usersWithSavings > 0 ? Math.round(totalLatestSavings / usersWithSavings) : 0,
      max: maxSavings,
    },
    exerciseRate: totalEntryCount > 0 ? Math.round((exercisedCount / totalEntryCount) * 100) : 0,
    learningRate: totalEntryCount > 0 ? Math.round((learnedCount / totalEntryCount) * 100) : 0,
  };

  return { overview, users: userSummaries };
}

async function handleUsers() {
  const result = await handleOverview();
  return { users: result.users };
}

async function handleUser(email) {
  // Find user auth blob
  const userData = await blobGet('auth', `user_${email}`);
  if (!userData) return { error: '用户不存在' };

  const user = JSON.parse(userData);

  // Fetch entries
  const rawEntries = await blobGet('entries', `user_${user.userId}_entries`);
  let entries = {};
  if (rawEntries) {
    try { entries = JSON.parse(rawEntries).entries || {}; } catch (e) {}
  }

  const dates = Object.keys(entries).sort();
  const streaks = calculateStreaks(entries);

  // Mood distribution
  const moodTally = {};
  let exercisedCount = 0;
  let learnedCount = 0;
  const savingsProgress = [];
  const monthlyActivity = {};

  for (const date of dates) {
    const entry = entries[date];
    const mood = entry.mood || 'unknown';
    moodTally[mood] = (moodTally[mood] || 0) + 1;
    if (entry.exercised) exercisedCount++;
    if (entry.learned) learnedCount++;

    if (entry.savings != null) {
      savingsProgress.push({ date, amount: entry.savings });
    }

    const month = date.slice(0, 7);
    monthlyActivity[month] = (monthlyActivity[month] || 0) + 1;
  }

  const total = dates.length;

  const stats = {
    totalEntries: total,
    currentStreak: streaks.current,
    bestStreak: streaks.best,
    moodDistribution: moodTally,
    savingsProgress,
    exerciseRate: total > 0 ? Math.round((exercisedCount / total) * 100) : 0,
    learningRate: total > 0 ? Math.round((learnedCount / total) * 100) : 0,
    monthlyActivity,
    firstEntry: dates.length > 0 ? dates[0] : null,
    lastEntry: dates.length > 0 ? dates[dates.length - 1] : null,
  };

  return {
    user: { userId: user.userId, email: user.email, createdAt: user.createdAt },
    stats,
    entries: dates.slice(-30).map(date => ({ date, ...entries[date] })),
  };
}

// ── Main handler ──────────────────────────────────────

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '请求格式错误' }) };
  }

  const { adminPassword, action, email } = body;
  if (!adminPassword || !action) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '缺少参数' }) };
  }

  // Validate admin password
  const validPassword = await getAdminPassword();
  if (adminPassword !== validPassword) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '密码错误' }) };
  }

  // Handle change_password action
  if (action === 'change_password' && body.newPassword) {
    await blobSet('auth', 'admin_config', JSON.stringify({ password: body.newPassword }));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  }

  try {
    let result;
    switch (action) {
      case 'overview':
        result = await handleOverview();
        break;
      case 'users':
        result = await handleUsers();
        break;
      case 'user':
        if (!email) return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '缺少 email 参数' }) };
        result = await handleUser(email);
        break;
      default:
        return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '未知 action' }) };
    }

    if (result.error) {
      return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: result.error }) };
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};

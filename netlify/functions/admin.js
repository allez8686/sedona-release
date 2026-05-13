const { blobGet, blobSet } = require('./lib/storage');

const SITE_ID = '8a610647-ecc2-4678-9ef8-45927596772c';
const AUTH_TOKEN = 'nfc_kGRduNRdugW7gPBE6Cr8j6CQzzyEANZs2981';
const DEFAULT_PASSWORD = '060515';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getAdminPassword() {
  try {
    const data = await blobGet('auth', 'admin_config');
    if (data) { const config = JSON.parse(data); return config.password || DEFAULT_PASSWORD; }
  } catch (e) {}
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
  const decoded = decodeURIComponent(rawKey);
  const idx = decoded.indexOf('/');
  if (idx === -1) return null;
  return { store: decoded.slice(0, idx), key: decoded.slice(idx + 1) };
}

function isUserRecord(store, key) {
  return store === 'auth' && key.startsWith('user_') && key.includes('@');
}

function isEntryBlob(store, key) {
  return store === 'entries' && key.startsWith('user_') && key.endsWith('_entries');
}

function extractUserIdFromEntryKey(key) {
  return key.slice(5, -8);
}

function calculateStreaks(entriesByDate) {
  const dates = Object.keys(entriesByDate).sort();
  if (dates.length === 0) return { current: 0, best: 0 };
  let best = 1, current = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1]), curr = new Date(dates[i]);
    const diff = Math.round((curr - prev) / 86400000);
    if (diff === 1) current++;
    else { best = Math.max(best, current); current = 1; }
  }
  best = Math.max(best, current);
  const lastDate = new Date(dates[dates.length - 1]);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffToToday = Math.round((today - lastDate) / 86400000);
  if (diffToToday > 1) current = 0;
  return { current, best };
}

// ── Core overview computation (expensive: reads all user/entry blobs) ──

async function computeOverview() {
  const blobs = await listAllBlobs();

  const userBlobKeys = [];
  const entryBlobKeys = [];
  for (const blob of blobs) {
    const parsed = parseBlobKey(blob.key);
    if (!parsed) continue;
    if (isUserRecord(parsed.store, parsed.key)) {
      userBlobKeys.push(parsed.key);
    } else if (isEntryBlob(parsed.store, parsed.key)) {
      entryBlobKeys.push({ key: parsed.key, lastModified: blob.last_modified });
    }
  }

  const userAuthResults = await Promise.allSettled(userBlobKeys.map(key => blobGet('auth', key)));
  const userMap = new Map();
  for (let i = 0; i < userBlobKeys.length; i++) {
    const result = userAuthResults[i];
    if (result.status !== 'fulfilled' || !result.value) continue;
    try {
      const user = JSON.parse(result.value);
      userMap.set(user.userId, { email: user.email, createdAt: user.createdAt });
    } catch (e) {}
  }

  const entryResults = await Promise.allSettled(entryBlobKeys.map(e => blobGet('entries', e.key)));
  const userEntries = new Map();
  for (let i = 0; i < entryBlobKeys.length; i++) {
    const result = entryResults[i];
    const userId = extractUserIdFromEntryKey(entryBlobKeys[i].key);
    if (result.status !== 'fulfilled' || !result.value) {
      userEntries.set(userId, { entries: {} });
      continue;
    }
    try {
      const data = JSON.parse(result.value);
      userEntries.set(userId, { entries: data.entries || {} });
    } catch (e) {
      userEntries.set(userId, { entries: {} });
    }
  }

  const now = new Date(); now.setHours(0, 0, 0, 0);
  const thirtyDaysAgo = new Date(now - 30 * 86400000);
  let totalEntries = 0, activeUsers = 0;
  const moodTally = {};
  let totalLatestSavings = 0, usersWithSavings = 0, maxSavings = 0;
  let exercisedCount = 0, learnedCount = 0, totalEntryCount = 0;
  const userSummaries = [];

  for (const [userId, userInfo] of userMap) {
    const entryData = userEntries.get(userId) || { entries: {} };
    const entries = entryData.entries;
    const dates = Object.keys(entries).sort();
    const entryCount = dates.length;
    totalEntries += entryCount;
    totalEntryCount += entryCount;
    const lastDate = dates.length > 0 ? dates[dates.length - 1] : null;
    if (lastDate && new Date(lastDate) >= thirtyDaysAgo) activeUsers++;

    let latestSavings = 0;
    if (dates.length > 0) {
      latestSavings = entries[dates[dates.length - 1]].savings || 0;
      if (latestSavings > 0) { totalLatestSavings += latestSavings; usersWithSavings++; }
      if (latestSavings > maxSavings) maxSavings = latestSavings;
    }

    for (const date of dates) {
      const entry = entries[date];
      const mood = entry.mood || 'unknown';
      moodTally[mood] = (moodTally[mood] || 0) + 1;
      if (entry.exercised) exercisedCount++;
      if (entry.learned) learnedCount++;
    }

    userSummaries.push({ userId, email: userInfo.email, createdAt: userInfo.createdAt, entryCount, lastActivity: lastDate, latestSavings });
  }

  userSummaries.sort((a, b) => {
    if (!a.lastActivity) return 1; if (!b.lastActivity) return -1;
    return b.lastActivity.localeCompare(a.lastActivity);
  });

  return {
    overview: {
      totalUsers: userMap.size, totalEntries, activeUsers,
      moodDistribution: moodTally,
      savingsStats: { average: usersWithSavings > 0 ? Math.round(totalLatestSavings / usersWithSavings) : 0, max: maxSavings },
      exerciseRate: totalEntryCount > 0 ? Math.round((exercisedCount / totalEntryCount) * 100) : 0,
      learningRate: totalEntryCount > 0 ? Math.round((learnedCount / totalEntryCount) * 100) : 0,
    },
    users: userSummaries,
  };
}

// ── Cached overview ──

async function handleOverview(forceRefresh) {
  const cacheKey = 'admin_cache';

  if (!forceRefresh) {
    try {
      const cached = await blobGet('auth', cacheKey);
      if (cached) {
        const cache = JSON.parse(cached);
        if (cache.cachedAt && (Date.now() - cache.cachedAt) < CACHE_TTL) {
          return { ...cache.data, _cached: true, _cachedAt: new Date(cache.cachedAt).toISOString() };
        }
      }
    } catch (e) {}
  }

  const data = await computeOverview();
  try {
    await blobSet('auth', cacheKey, JSON.stringify({ cachedAt: Date.now(), data }));
  } catch (e) {}
  return { ...data, _cached: false };
}

// ── Backup ──

async function handleBackup() {
  const blobs = await listAllBlobs();
  const userBlobKeys = [];

  for (const blob of blobs) {
    const parsed = parseBlobKey(blob.key);
    if (!parsed) continue;
    if (parsed.store === 'auth' && parsed.key.startsWith('user_') && parsed.key.includes('@')) {
      userBlobKeys.push(parsed.key);
    }
  }

  const users = [];
  const entries = {};

  for (const key of userBlobKeys) {
    try {
      const raw = await blobGet('auth', key);
      if (!raw) continue;
      const user = JSON.parse(raw);
      const safeUser = { userId: user.userId, email: user.email, createdAt: user.createdAt };
      users.push(safeUser);

      const entryRaw = await blobGet('entries', `user_${user.userId}_entries`);
      if (entryRaw) {
        try {
          const entryData = JSON.parse(entryRaw);
          entries[user.email] = entryData.entries || {};
        } catch (e) { entries[user.email] = {}; }
      }
    } catch (e) {}
  }

  return {
    exportedAt: new Date().toISOString(),
    totalUsers: users.length,
    users,
    entries,
    _backup: true,
  };
}

// ── User detail (same as before) ──

async function handleUser(email) {
  const userData = await blobGet('auth', `user_${email}`);
  if (!userData) return { error: '用户不存在' };
  const user = JSON.parse(userData);

  const rawEntries = await blobGet('entries', `user_${user.userId}_entries`);
  let entries = {};
  if (rawEntries) { try { entries = JSON.parse(rawEntries).entries || {}; } catch (e) {} }

  const dates = Object.keys(entries).sort();
  const streaks = calculateStreaks(entries);
  const moodTally = {};
  let exercisedCount = 0, learnedCount = 0;
  const savingsProgress = [], monthlyActivity = {};

  for (const date of dates) {
    const entry = entries[date];
    const mood = entry.mood || 'unknown';
    moodTally[mood] = (moodTally[mood] || 0) + 1;
    if (entry.exercised) exercisedCount++;
    if (entry.learned) learnedCount++;
    if (entry.savings != null) savingsProgress.push({ date, amount: entry.savings });
    const month = date.slice(0, 7);
    monthlyActivity[month] = (monthlyActivity[month] || 0) + 1;
  }

  const total = dates.length;
  return {
    user: { userId: user.userId, email: user.email, createdAt: user.createdAt },
    stats: {
      totalEntries: total, currentStreak: streaks.current, bestStreak: streaks.best,
      moodDistribution: moodTally, savingsProgress,
      exerciseRate: total > 0 ? Math.round((exercisedCount / total) * 100) : 0,
      learningRate: total > 0 ? Math.round((learnedCount / total) * 100) : 0,
      monthlyActivity, firstEntry: dates.length > 0 ? dates[0] : null, lastEntry: dates.length > 0 ? dates[dates.length - 1] : null,
    },
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

  const validPassword = await getAdminPassword();
  if (adminPassword !== validPassword) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '密码错误' }) };
  }

  if (action === 'change_password' && body.newPassword) {
    await blobSet('auth', 'admin_config', JSON.stringify({ password: body.newPassword }));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  }

  try {
    let result;
    switch (action) {
      case 'overview':
        result = await handleOverview(false);
        break;
      case 'refresh':
        result = await handleOverview(true);
        break;
      case 'backup':
        result = await handleBackup();
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

// Hybrid storage: tries @netlify/blobs auto-detect first, then REST API fallback
const SITE_ID = '8a610647-ecc2-4678-9ef8-45927596772c';
const AUTH_TOKEN = 'nfc_kGRduNRdugW7gPBE6Cr8j6CQzzyEANZs2981';

let blobsAvailable = null;
let _getStore = null;

function loadBlobs() {
  if (blobsAvailable !== null) return blobsAvailable;
  try {
    const blobs = require('@netlify/blobs');
    _getStore = blobs.getStore;
    // Test if blobs auto-detect works
    try { blobs.getStore({ name: '_test', consistency: 'strong' }); } catch {}
    blobsAvailable = true;
  } catch (e) {
    blobsAvailable = false;
  }
  return blobsAvailable;
}

async function blobGet(store, key) {
  if (loadBlobs()) {
    try {
      const s = _getStore({ name: store, consistency: 'strong' });
      return await s.get(key);
    } catch (e) {
      // Fall through to REST API
    }
  }
  // REST API fallback
  const res = await fetch(
    `https://api.netlify.com/api/v1/sites/${SITE_ID}/blobs/${encodeURIComponent(`${store}/${key}`)}`,
    { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Blob GET failed: ${res.status}`);
  const { url } = await res.json();
  const s3Res = await fetch(url);
  if (s3Res.status === 404) return null;
  if (!s3Res.ok) throw new Error(`S3 GET failed: ${s3Res.status}`);
  return await s3Res.text();
}

async function blobSet(store, key, value) {
  if (loadBlobs()) {
    try {
      const s = _getStore({ name: store, consistency: 'strong' });
      await s.set(key, value);
      return;
    } catch (e) {
      // Fall through to REST API
    }
  }
  // REST API fallback
  const res = await fetch(
    `https://api.netlify.com/api/v1/sites/${SITE_ID}/blobs/${encodeURIComponent(`${store}/${key}`)}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${AUTH_TOKEN}` } }
  );
  if (!res.ok) throw new Error(`Blob PUT failed: ${res.status}`);
  const { url } = await res.json();
  const s3Res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: value });
  if (!s3Res.ok) throw new Error(`S3 upload failed: ${s3Res.status}`);
}

module.exports = { blobGet, blobSet };

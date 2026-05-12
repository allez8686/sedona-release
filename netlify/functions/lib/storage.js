const SITE_ID = '8a610647-ecc2-4678-9ef8-45927596772c';
const AUTH_TOKEN = 'nfc_kGRduNRdugW7gPBE6Cr8j6CQzzyEANZs2981';

function apiPath(store, key) {
  return `https://api.netlify.com/api/v1/sites/${SITE_ID}/blobs/${encodeURIComponent(`${store}/${key}`)}`;
}

async function blobGet(store, key) {
  const res = await fetch(apiPath(store, key), {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Blob GET failed: ${res.status}`);
  const { url } = await res.json();
  const s3Res = await fetch(url);
  if (s3Res.status === 404) return null;
  if (!s3Res.ok) throw new Error(`S3 GET failed: ${s3Res.status}`);
  return await s3Res.text();
}

async function blobSet(store, key, value) {
  const res = await fetch(apiPath(store, key), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Blob PUT failed: ${res.status}`);
  const { url } = await res.json();
  const s3Res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: value,
  });
  if (!s3Res.ok) throw new Error(`S3 upload failed: ${s3Res.status}`);
}

module.exports = { blobGet, blobSet };


// index.js — 최소 변경 최종본 (업로드 인증 없음 + 운영자 기능 추가)
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
let admin = null;
try { admin = require("firebase-admin"); } catch (_) {}

const app = express();
app.use(cors());
app.use(express.json({ limit: '30mb' }));

const dbFilePath = path.join(__dirname, "database.json");

// DB helpers
const readDatabase = (callback) => {
  fs.readFile(dbFilePath, "utf8", (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return callback(null, []);
      return callback(err);
    }
    try { callback(null, JSON.parse(data || "[]")); }
    catch (parseErr) { callback(parseErr); }
  });
};
const writeDatabase = (data, callback) => {
  fs.writeFile(dbFilePath, JSON.stringify(data, null, 2), "utf8", callback);
};

// Admin (optional)
const ADMIN_UIDS = new Set((process.env.ADMIN_UIDS || "").split(",").map(s => s.trim()).filter(Boolean));
if (admin) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const json = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(json) });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({});
    }
  } catch (e) { console.log("[Firebase] init error:", e?.message || e); }
}
async function verifyFirebaseToken(req, res, next) {
  try {
    if (!admin) return res.status(500).json({ error: "ADMIN_SDK_NOT_INSTALLED" });
    const m = (req.headers.authorization || "").match(/^Bearer\\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: "NO_TOKEN" });
    const decoded = await admin.auth().verifyIdToken(m[1]);
    req.user = { uid: decoded.uid, name: decoded.name || decoded.displayName || (decoded.email ? decoded.email.split("@")[0] : "익명") };
    next();
  } catch (e) { return res.status(401).json({ error: "BAD_TOKEN" }); }
}
function requireAdmin(req, res, next) {
  if (!req.user || !ADMIN_UIDS.has(req.user.uid)) return res.status(403).json({ error: "NOT_ADMIN" });
  next();
}

// Routes
app.get("/", (req,res)=>res.send("OK"));
app.get("/markers", (req, res) => {
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    markers.forEach(m => { if (!m.status) m.status = "open"; });
    res.json(markers);
  });
});
app.post("/markers", (req, res) => {
  const { lat, lon, imgUrl, category, uploader, uploaderUid, status } = req.body;
  if (typeof lat !== "number" || typeof lon !== "number" || !imgUrl) {
    return res.status(400).json({ error: "INVALID_BODY" });
  }
  const newMarker = {
    id: Date.now().toString(),
    lat, lon, imgUrl,
    category: category || '분류 안됨',
    uploader: uploader || '익명',
    uploaderUid: uploaderUid || null,
    status: status || 'open',
    createdAt: Date.now()
  };
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    markers.push(newMarker);
    writeDatabase(markers, (writeErr) => {
      if (writeErr) return res.status(500).json({ error: "Failed to save marker" });
      res.status(201).json(newMarker);
    });
  });
});
app.post("/markers/:id/cleanup-request", (req, res) => {
  const { id } = req.params;
  const { claimedByUid = null, claimedByName = '익명' } = req.body || {};
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    const idx = markers.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: "Marker not found" });
    if (markers[idx].status !== 'open') return res.status(409).json({ error: "ALREADY_PENDING" });
    markers[idx].status = 'pending';
    markers[idx].claimedByUid = claimedByUid;
    markers[idx].claimedByName = claimedByName;
    writeDatabase(markers, (writeErr) => {
      if (writeErr) return res.status(500).json({ error: "Failed to update marker" });
      res.json({ id, status: 'pending', claimedByName });
    });
  });
});
app.post("/markers/:id/approve", admin ? [verifyFirebaseToken, requireAdmin] : [], (req, res) => {
  if (!admin) return res.status(500).json({ error: "ADMIN_SDK_NOT_INSTALLED" });
  const { id } = req.params;
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    const idx = markers.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: "Marker not found" });
    // 포인트 지급은 로깅만 (추가 저장 원하면 말해줘)
    const { uploaderUid, claimedByUid } = markers[idx];
    console.log("[approve] award +10 uploader:", uploaderUid, "claimer:", claimedByUid);
    markers.splice(idx, 1);
    writeDatabase(markers, (writeErr) => {
      if (writeErr) return res.status(500).json({ error: "Failed to approve" });
      res.json({ ok: true, awarded: { uploaderUid, claimedByUid } });
    });
  });
});
app.post("/markers/:id/reject", admin ? [verifyFirebaseToken, requireAdmin] : [], (req, res) => {
  if (!admin) return res.status(500).json({ error: "ADMIN_SDK_NOT_INSTALLED" });
  const { id } = req.params;
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    const idx = markers.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: "Marker not found" });
    markers[idx].status = 'open';
    markers[idx].claimedByUid = null;
    markers[idx].claimedByName = null;
    writeDatabase(markers, (writeErr) => {
      if (writeErr) return res.status(500).json({ error: "Failed to reject" });
      res.json({ id, status: 'open' });
    });
  });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server is running on port ${PORT}`); });

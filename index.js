// index.js — 업로드 무인증 + 운영자 승인/취소(토큰검증) + 분류별 포인트 + "내 포인트" 조회
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

let admin = null;
try { admin = require("firebase-admin"); } catch (_) {}

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" }));

// 파일 경로
const dbFilePath = path.join(__dirname, "database.json");
const pointsFilePath = path.join(__dirname, "points.json");

// 공통 파일 헬퍼
function readJsonSafe(filePath, fallback, cb) {
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) { if (err.code === "ENOENT") return cb(null, fallback); return cb(err); }
    try { cb(null, data ? JSON.parse(data) : fallback); }
    catch { cb(null, fallback); }
  });
}
function writeJsonSafe(filePath, obj, cb) {
  fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8", cb);
}
const readDatabase = (cb) => readJsonSafe(dbFilePath, [], cb);
const writeDatabase = (data, cb) => writeJsonSafe(dbFilePath, data, cb);
const readPoints = (cb) => readJsonSafe(pointsFilePath, {}, cb);
const writePoints = (data, cb) => writeJsonSafe(pointsFilePath, data, cb);

// Firebase Admin & 운영자
const ADMIN_UIDS = new Set((process.env.ADMIN_UIDS || "").split(",").map(s=>s.trim()).filter(Boolean));
if (admin) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const json = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(json) });
      console.log("[Firebase] Admin initialized");
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({});
      console.log("[Firebase] Admin initialized (ADC)");
    } else {
      console.log("[Firebase] Admin not configured");
    }
  } catch (e) {
    console.log("[Firebase] init error:", e?.message || e);
  }
}
async function verifyFirebaseToken(req, res, next) {
  try {
    if (!admin) return res.status(500).json({ error: "ADMIN_SDK_NOT_INSTALLED" });
    const m = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: "NO_TOKEN" });
    const decoded = await admin.auth().verifyIdToken(m[1]);
    req.user = {
      uid: decoded.uid,
      name: decoded.name || decoded.displayName || (decoded.email ? decoded.email.split("@")[0] : "익명"),
    };
    next();
  } catch {
    return res.status(401).json({ error: "BAD_TOKEN" });
  }
}
function requireAdmin(req, res, next) {
  if (!req.user || !ADMIN_UIDS.has(req.user.uid)) return res.status(403).json({ error: "NOT_ADMIN" });
  next();
}

// 포인트 규칙
const AWARD_UPLOADER_FIXED = 2;
function claimerAwardByCategory(categoryRaw) {
  const c = (categoryRaw || "").toString();
  const s = c.replace(/\s+/g, ""); // 공백 제거
  if (s.includes("재활용")) return 200;
  if (s.includes("위험") || s.includes("더러운")) return 300;
  if (s.includes("소형")) return 10;
  if (s.includes("일반")) return 100;
  return 0; // 매칭 실패 시 0
}
function keyForUser({ uid, name }) {
  if (uid && String(uid).trim()) return `uid:${String(uid).trim()}`;
  if (name && String(name).trim()) return `name:${String(name).trim()}`;
  return null;
}
function addPoints(pts, key, delta) {
  if (!key || !Number.isFinite(delta)) return;
  if (typeof pts[key] !== "number") pts[key] = 0;
  pts[key] += delta;
}

// 라우트
app.get("/", (_, res) => res.send("OK"));

app.get("/markers", (_, res) => {
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    markers.forEach(m => { if (!m.status) m.status = "open"; });
    res.json(markers);
  });
});

// 업로드(무인증)
app.post("/markers", (req, res) => {
  const { lat, lon, imgUrl, category, uploader, uploaderUid, status } = req.body || {};
  if (typeof lat !== "number" || typeof lon !== "number" || !imgUrl) return res.status(400).json({ error: "INVALID_BODY" });
  const newMarker = {
    id: Date.now().toString(),
    lat, lon, imgUrl,
    category: category || "분류 안됨",
    uploader: uploader || "익명",
    uploaderUid: uploaderUid || null,
    status: status || "open",
    createdAt: Date.now()
  };
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    markers.push(newMarker);
    writeDatabase(markers, (werr) => {
      if (werr) return res.status(500).json({ error: "Failed to save marker" });
      res.status(201).json(newMarker);
    });
  });
});

// 수배범 처리 완료(무인증) -> pending 전환 + 요청자 저장
app.post("/markers/:id/cleanup-request", (req, res) => {
  const { id } = req.params;
  const { claimedByUid = null, claimedByName = "익명" } = req.body || {};
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    const idx = markers.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: "Marker not found" });
    if (markers[idx].status !== "open") return res.status(409).json({ error: "ALREADY_PENDING" });
    markers[idx].status = "pending";
    markers[idx].claimedByUid = claimedByUid;
    markers[idx].claimedByName = claimedByName;
    writeDatabase(markers, (werr) => {
      if (werr) return res.status(500).json({ error: "Failed to update marker" });
      res.json({ id, status: "pending", claimedByName });
    });
  });
});

// 승인(운영자) — 여기서 포인트 지급
app.post("/markers/:id/approve", admin ? [verifyFirebaseToken, requireAdmin] : [], (req, res) => {
  if (!admin) return res.status(500).json({ error: "ADMIN_SDK_NOT_INSTALLED" });

  const { id } = req.params;
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    const idx = markers.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: "Marker not found" });

    const mk = markers[idx];
    const uploaderKey = keyForUser({ uid: mk.uploaderUid, name: mk.uploader });
    const claimerKey  = keyForUser({ uid: mk.claimedByUid, name: mk.claimedByName });

    const claimerDelta = (mk.status === "pending") ? claimerAwardByCategory(mk.category) : 0;
    const uploaderDelta = AWARD_UPLOADER_FIXED;

    readPoints((perr, pts) => {
      if (perr) return res.status(500).json({ error: "Failed to read points" });

      if (uploaderKey) addPoints(pts, uploaderKey, uploaderDelta);
      if (claimerKey && claimerDelta > 0) addPoints(pts, claimerKey, claimerDelta);

      // 마커 삭제 후 포인트 저장
      markers.splice(idx, 1);
      writeDatabase(markers, (werr) => {
        if (werr) return res.status(500).json({ error: "Failed to approve" });
        writePoints(pts, (pwerr) => {
          if (pwerr) return res.status(500).json({ error: "Failed to update points" });
          res.json({
            ok: true,
            awarded: {
              uploader: uploaderKey ? { key: uploaderKey, delta: uploaderDelta } : null,
              claimer:  (claimerKey && claimerDelta>0) ? { key: claimerKey, delta: claimerDelta } : null
            }
          });
        });
      });
    });
  });
});

// 취소(운영자)
app.post("/markers/:id/reject", admin ? [verifyFirebaseToken, requireAdmin] : [], (req, res) => {
  if (!admin) return res.status(500).json({ error: "ADMIN_SDK_NOT_INSTALLED" });
  const { id } = req.params;
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    const idx = markers.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: "Marker not found" });
    markers[idx].status = "open";
    markers[idx].claimedByUid = null;
    markers[idx].claimedByName = null;
    writeDatabase(markers, (werr) => {
      if (werr) return res.status(500).json({ error: "Failed to reject" });
      res.json({ id, status: "open" });
    });
  });
});

// 포인트 조회 (디버그/표시용)
app.get("/points", (_, res) => {
  readPoints((err, pts) => {
    if (err) return res.status(500).json({ error: "Failed to read points" });
    res.json(pts);
  });
});
app.get("/points/:key", (req, res) => {
  readPoints((err, pts) => {
    if (err) return res.status(500).json({ error: "Failed to read points" });
    res.json({ key: req.params.key, points: pts[req.params.key] || 0 });
  });
});
// 로그인 사용자의 "내 포인트" (uid 기준, 토큰 필요)
app.get("/my-points",
  admin ? verifyFirebaseToken : (req,res,next)=>next(),
  (req,res)=>{
    if (!req.user) return res.json({ key:null, points:0, note:"no-auth" });
    const key = `uid:${req.user.uid}`;
    readPoints((err, pts)=>{
      if (err) return res.status(500).json({ error:"Failed to read points" });
      res.json({ key, points: pts[key] || 0 });
    });
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

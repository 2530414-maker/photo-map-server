// index.js — 업로드는 인증 없이, 운영자 승인/취소만 토큰검증 + 포인트 적립
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

let admin = null;
try { admin = require("firebase-admin"); } catch (_) {}

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" })); // 큰 이미지도 OK

const dbFilePath = path.join(__dirname, "database.json");
const pointsFilePath = path.join(__dirname, "points.json");

// ---- DB helpers ----
const readDatabase = (cb) => {
  fs.readFile(dbFilePath, "utf8", (err, data) => {
    if (err) { if (err.code === "ENOENT") return cb(null, []); return cb(err); }
    try { cb(null, JSON.parse(data || "[]")); } catch (e) { cb(e); }
  });
};
const writeDatabase = (data, cb) => fs.writeFile(dbFilePath, JSON.stringify(data, null, 2), "utf8", cb);

// ---- Points helpers ----
const readPoints = (cb) => {
  fs.readFile(pointsFilePath, "utf8", (err, data) => {
    if (err) { if (err.code === "ENOENT") return cb(null, {}); return cb(err); }
    try { cb(null, JSON.parse(data || "{}")); } catch (e) { cb(e); }
  });
};
const writePoints = (obj, cb) => fs.writeFile(pointsFilePath, JSON.stringify(obj, null, 2), "utf8", cb);
function addPoints(uid, name, delta, cb) {
  if (!uid) return cb(null, null); // uid 없으면 스킵
  readPoints((err, p) => {
    if (err) return cb(err);
    if (!p[uid]) p[uid] = { name: name || "익명", points: 0 };
    p[uid].points += delta;
    if (name && name !== "익명") p[uid].name = name;
    writePoints(p, (werr) => { if (werr) return cb(werr); cb(null, p[uid].points); });
  });
}

// ---- Admin 초기화 ----
const ADMIN_UIDS = new Set((process.env.ADMIN_UIDS || "").split(",").map(s=>s.trim()).filter(Boolean));
if (admin) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const json = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(json) });
      console.log("[Firebase] Admin initialized by FIREBASE_SERVICE_ACCOUNT");
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({});
      console.log("[Firebase] Admin initialized by GOOGLE_APPLICATION_CREDENTIALS");
    } else {
      console.log("[Firebase] Admin not configured (approve/reject will 500)");
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
    req.user = { uid: decoded.uid, name: decoded.name || decoded.displayName || (decoded.email ? decoded.email.split("@")[0] : "익명") };
    next();
  } catch (e) {
    return res.status(401).json({ error: "BAD_TOKEN" });
  }
}
function requireAdmin(req, res, next) {
  if (!req.user || !ADMIN_UIDS.has(req.user.uid)) return res.status(403).json({ error: "NOT_ADMIN" });
  next();
}

// ---- Routes ----
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

// 대기 전환(로그인 강제 안 함)
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

// 승인(운영자) — 포인트 적립 후 마커 삭제
app.post("/markers/:id/approve", admin ? [verifyFirebaseToken, requireAdmin] : [], (req, res) => {
  if (!admin) return res.status(500).json({ error: "ADMIN_SDK_NOT_INSTALLED" });
  const { id } = req.params;

  // 포인트 상수 (환경변수로 조정 가능)
  const UPLOADER_AWARD = Number(process.env.UPLOADER_AWARD || 10);
  const CLAIMER_AWARD  = Number(process.env.CLAIMER_AWARD  || 10);

  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    const idx = markers.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: "Marker not found" });

    const marker = markers[idx];
    const { uploaderUid, uploader, claimedByUid, claimedByName } = marker;
    console.log("[approve] award +%d uploader:%s claimer:%s", UPLOADER_AWARD, uploaderUid, claimedByUid);

    // 포인트 적립 순차 수행
    addPoints(uploaderUid, uploader, UPLOADER_AWARD, (e1, uploaderTotal) => {
      if (e1) return res.status(500).json({ error: "Failed to add points (uploader)" });
      addPoints(claimedByUid, claimedByName, CLAIMER_AWARD, (e2, claimerTotal) => {
        if (e2) return res.status(500).json({ error: "Failed to add points (claimer)" });

        // 마커 제거
        markers.splice(idx, 1);
        writeDatabase(markers, (werr) => {
          if (werr) return res.status(500).json({ error: "Failed to approve" });
          res.json({
            ok: true,
            awarded: {
              uploader: { uid: uploaderUid || null, name: uploader || "익명", delta: UPLOADER_AWARD, total: uploaderTotal ?? null },
              claimer:  { uid: claimedByUid || null, name: claimedByName || "익명", delta: CLAIMER_AWARD, total: claimerTotal ?? null }
            }
          });
        });
      });
    });
  });
});

// 취소(운영자) — 대기로 되돌림
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

// 권한 확인용
app.get("/debug/whoami",
  admin ? verifyFirebaseToken : (req, res) => res.status(500).json({ error: "ADMIN_SDK_NOT_INSTALLED" }),
  (req, res) => res.json({ uid: req.user?.uid || null, isAdmin: ADMIN_UIDS.has(req.user?.uid), ADMIN_UIDS: [...ADMIN_UIDS] })
);

// 내 포인트 조회
app.get("/me/points",
  admin ? verifyFirebaseToken : (req, res) => res.status(500).json({ error: "ADMIN_SDK_NOT_INSTALLED" }),
  (req, res) => {
    readPoints((err, p) => {
      if (err) return res.status(500).json({ error: "Failed to read points" });
      const me = p[req.user.uid] || { name: req.user.name, points: 0 };
      res.json(me);
    });
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

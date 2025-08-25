// index.js — 업로드는 인증 없이, 운영자 승인/취소만 토큰검증 + 포인트 적립(points.json)
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

let admin = null;
try { admin = require("firebase-admin"); } catch (_) {}

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" })); // 큰 이미지도 OK

// ===== 파일 경로 =====
const dbFilePath = path.join(__dirname, "database.json");   // 마커 저장
const pointsFilePath = path.join(__dirname, "points.json"); // 포인트 저장 (초기: {})

// ===== 공통 파일 헬퍼 =====
function readJsonSafe(filePath, fallback, cb) {
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      if (err.code === "ENOENT") return cb(null, fallback);
      return cb(err);
    }
    try { cb(null, data ? JSON.parse(data) : fallback); }
    catch (e) { cb(null, fallback); } // 손상돼 있어도 무시하고 초기값
  });
}
function writeJsonSafe(filePath, obj, cb) {
  fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8", cb);
}
const readDatabase = (cb) => readJsonSafe(dbFilePath, [], cb);
const writeDatabase = (data, cb) => writeJsonSafe(dbFilePath, data, cb);
const readPoints = (cb) => readJsonSafe(pointsFilePath, {}, cb);
const writePoints = (data, cb) => writeJsonSafe(pointsFilePath, data, cb);

// ===== Firebase Admin & 운영자 =====
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
    req.user = {
      uid: decoded.uid,
      name: decoded.name || decoded.displayName || (decoded.email ? decoded.email.split("@")[0] : "익명"),
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: "BAD_TOKEN" });
  }
}
function requireAdmin(req, res, next) {
  if (!req.user || !ADMIN_UIDS.has(req.user.uid)) return res.status(403).json({ error: "NOT_ADMIN" });
  next();
}

// ===== 라우트 =====
app.get("/", (_, res) => res.send("OK"));

app.get("/markers", (_, res) => {
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    markers.forEach(m => { if (!m.status) m.status = "open"; });
    res.json(markers);
  });
});

// 업로드(무인증) — 기존 그대로
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

// 대기 전환(무인증) — 기존 그대로
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

// ===== 포인트 유틸 =====
const AWARD_UPLOADER = 10; // 업로더 기본 포인트
const AWARD_CLAIMER  = 10; // '수배범 처리 완료' 누른 사람 포인트

function keyForUser({ uid, name }) {
  // uid가 있으면 uid로, 없으면 이름으로(중복 가능성 있지만 로그인 안 한 케이스 대응)
  if (uid && typeof uid === "string" && uid.trim()) return `uid:${uid.trim()}`;
  if (name && typeof name === "string" && name.trim()) return `name:${name.trim()}`;
  return null;
}
function award(pointsObj, key, delta) {
  if (!key) return;
  if (typeof pointsObj[key] !== "number") pointsObj[key] = 0;
  pointsObj[key] += delta;
}

// 승인(운영자) — 여기서 포인트 적립 수행
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

    // 포인트 파일 읽고 적립
    readPoints((perr, pts) => {
      if (perr) return res.status(500).json({ error: "Failed to read points" });

      // 규칙: pending 상태(=누군가 '수배범 처리 완료'를 눌렀을 때)는 둘 다 지급,
      // 그 외(open에서 운영자가 즉시 확인)는 업로더만 지급
      if (uploaderKey) award(pts, uploaderKey, AWARD_UPLOADER);
      if (mk.status === "pending" && claimerKey) award(pts, claimerKey, AWARD_CLAIMER);

      // 마커 삭제 후, 포인트 저장
      markers.splice(idx, 1);
      writeDatabase(markers, (werr) => {
        if (werr) return res.status(500).json({ error: "Failed to approve" });

        writePoints(pts, (pwerr) => {
          if (pwerr) return res.status(500).json({ error: "Failed to update points" });

          res.json({
            ok: true,
            awarded: {
              uploader: uploaderKey ? { key: uploaderKey, delta: AWARD_UPLOADER } : null,
              claimer:  (mk.status === "pending" && claimerKey) ? { key: claimerKey, delta: AWARD_CLAIMER } : null
            }
          });
        });
      });
    });
  });
});

// 취소(운영자) — 포인트 변화 없음, 기존 그대로
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

// (선택) 포인트 확인용 간단 API (디버깅 편의)
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

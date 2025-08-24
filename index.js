// index.js — 기존 코드에 기능만 추가 (업로드 인증 없음)
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// (선택) 운영자 보호에 Firebase Admin을 쓸 거면 설치: npm i firebase-admin
let admin = null;
try { admin = require("firebase-admin"); } catch (_) { /* optional */ }

const app = express();
app.use(cors());
app.use(express.json({ limit: '30mb' })); // 여유 있게 30MB로 올림 (원래 10MB)

const dbFilePath = path.join(__dirname, "database.json");

// --- helper: DB 읽기/쓰기 (기존 그대로) ---
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

// --- (선택) Firebase Admin 초기화: 운영자 보호용 ---
const ADMIN_UIDS = new Set((process.env.ADMIN_UIDS || "").split(",").map(s => s.trim()).filter(Boolean));
if (admin) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const json = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(json) });
      console.log("[Firebase] Admin initialized");
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({});
      console.log("[Firebase] Admin initialized from credentials file");
    } else {
      console.log("[Firebase] Admin not configured (approve/reject에서 403 날 수 있음)");
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
      name: decoded.name || decoded.displayName || (decoded.email ? decoded.email.split("@")[0] : "익명")
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: "BAD_TOKEN" });
  }
}
function requireAdmin(req, res, next) {
  if (!req.user || !ADMIN_UIDS.has(req.user.uid)) {
    return res.status(403).json({ error: "NOT_ADMIN" });
  }
  next();
}

// ---------------- 기존 라우트 유지 (+ 몇 줄만 보강) ----------------

// GET /markers (그대로)
app.get("/markers", (req, res) => {
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    // 새 필드가 없던 기존 데이터 호환
    markers.forEach(m => { if (!m.status) m.status = "open"; });
    res.json(markers);
  });
});

// POST /markers (업로드는 인증 없이 유지)
// 기존 필드 + (있으면) uploader/uploaderUid/status도 저장
app.post("/markers", (req, res) => {
  const { lat, lon, imgUrl, category, uploader, uploaderUid, status } = req.body;
  if (typeof lat !== "number" || typeof lon !== "number" || !imgUrl) {
    return res.status(400).json({ error: "INVALID_BODY" });
  }
  const newMarker = {
    id: Date.now().toString(),
    lat,
    lon,
    imgUrl,
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

// (기존) 삭제 라우트는 필요시 유지
app.delete("/markers/:id", (req, res) => {
  const { id } = req.params;
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    const filtered = markers.filter(m => m.id !== id);
    if (filtered.length === markers.length) return res.status(404).json({ error: "Marker not found" });
    writeDatabase(filtered, (writeErr) => {
      if (writeErr) return res.status(500).json({ error: "Failed to delete marker" });
      res.status(200).json({ message: "Marker deleted successfully" });
    });
  });
});

// ---------------- 새로 추가된 기능 라우트(최소 변경) ----------------

// 수배범 처리 완료 → 대기 상태로 (로그인 강제 안 함: 최소 변경)
// 원하면 verifyFirebaseToken 추가 가능
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

// 운영자만: 확인(approve) → 포인트 지급 후 마커 삭제
app.post("/markers/:id/approve", admin ? [verifyFirebaseToken, requireAdmin] : [], (req, res) => {
  if (!admin) return res.status(500).json({ error: "ADMIN_SDK_NOT_INSTALLED" });
  const { id } = req.params;
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    const idx = markers.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: "Marker not found" });

    // 포인트 지급은 현재는 로깅만(원하면 파일/DB 저장 추가 가능)
    const { uploaderUid, claimedByUid } = markers[idx];
    console.log("[approve] award +10 to uploader:", uploaderUid, "and claimer:", claimedByUid);

    markers.splice(idx, 1);
    writeDatabase(markers, (writeErr) => {
      if (writeErr) return res.status(500).json({ error: "Failed to approve" });
      res.json({ ok: true, awarded: { uploaderUid, claimedByUid } });
    });
  });
});

// 운영자만: 취소(reject) → open 복귀
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
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

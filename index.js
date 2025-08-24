
// index.js — CommonJS, minimal changes from your current server
// npm i firebase-admin
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const dbFilePath = path.join(__dirname, "database.json");
const pointsFilePath = path.join(__dirname, "points.json"); // (자동 생성)

// ---- Firebase Admin (token verify only) ----
(function initFirebaseAdmin() {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const json = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(json) });
      console.log("[Firebase] Initialized from FIREBASE_SERVICE_ACCOUNT");
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({});
      console.log("[Firebase] Initialized from GOOGLE_APPLICATION_CREDENTIALS file");
    } else {
      console.warn("[Firebase] WARNING: No service account configured. Admin endpoints will fail.");
    }
  } catch (e) {
    console.warn("[Firebase] init error:", e && e.message ? e.message : e);
  }
})();

async function verifyFirebaseToken(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const m = header.match(/^Bearer\s+(.+)$/i);
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

const ADMIN_UIDS = new Set((process.env.ADMIN_UIDS || "").split(",").map(s => s.trim()).filter(Boolean));
function requireAdmin(req, res, next) {
  if (!req.user || !ADMIN_UIDS.has(req.user.uid)) {
    return res.status(403).json({ error: "NOT_ADMIN" });
  }
  next();
}

// ---- tiny JSON helpers ----
function readJson(file, fallback) {
  try {
    const txt = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (!txt) return fallback;
    return JSON.parse(txt);
  } catch(e) {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// ensure files
if (!fs.existsSync(dbFilePath)) writeJson(dbFilePath, []);
if (!fs.existsSync(pointsFilePath)) writeJson(pointsFilePath, {});

// points simple helper
function addPoints(uid, amount) {
  if (!uid) return;
  const table = readJson(pointsFilePath, {});
  table[uid] = (table[uid] || 0) + amount;
  writeJson(pointsFilePath, table);
  return table[uid];
}

// ---- existing helpers ----
const readDatabase = (callback) => {
  fs.readFile(dbFilePath, "utf8", (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return callback(null, []);
      return callback(err);
    }
    try {
      callback(null, JSON.parse(data || "[]"));
    } catch (parseErr) {
      callback(parseErr);
    }
  });
};

const writeDatabase = (data, callback) => {
  fs.writeFile(dbFilePath, JSON.stringify(data, null, 2), "utf8", callback);
};

// ---- routes ----
app.get("/", (req, res) => res.send("OK"));

app.get("/markers", (req, res) => {
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    // backward-compat: ensure status field
    markers.forEach(m => { if (!m.status) m.status = "open"; });
    res.json(markers);
  });
});

// NOTE: now protected by token (so we can capture uploader info reliably)
app.post("/markers", verifyFirebaseToken, (req, res) => {
  const { lat, lon, imgUrl, category, uploader, uploaderUid } = req.body;
  if (typeof lat !== "number" || typeof lon !== "number" || !imgUrl) {
    return res.status(400).json({ error: "INVALID_BODY" });
  }
  const newMarker = {
    id: Date.now().toString(),
    lat,
    lon,
    imgUrl,
    category: category || '분류 안됨',
    uploader: uploader || req.user.name,
    uploaderUid: uploaderUid || req.user.uid,
    status: "open",
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

// (optional legacy) keep delete for admin manual ops if needed
app.delete("/markers/:id", verifyFirebaseToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    const filteredMarkers = markers.filter(marker => marker.id !== id);
    if (markers.length === filteredMarkers.length) {
      return res.status(404).json({ error: "Marker not found" });
    }
    writeDatabase(filteredMarkers, (writeErr) => {
      if (writeErr) return res.status(500).json({ error: "Failed to delete marker" });
      res.status(200).json({ message: "Marker deleted successfully" });
    });
  });
});

// user action: claim cleanup (수배범 처리 완료) -> status 'pending'
app.post("/markers/:id/cleanup-request", verifyFirebaseToken, (req, res) => {
  const { id } = req.params;
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    const idx = markers.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: "Marker not found" });
    if (markers[idx].status && markers[idx].status !== "open") {
      return res.status(409).json({ error: "ALREADY_PENDING" });
    }
    markers[idx].status = "pending";
    markers[idx].claimedByUid = req.user.uid;
    markers[idx].claimedByName = (req.body && req.body.claimedByName) ? req.body.claimedByName : req.user.name;
    writeDatabase(markers, (writeErr) => {
      if (writeErr) return res.status(500).json({ error: "Failed to update marker" });
      res.json({ id, status: "pending", claimedByName: markers[idx].claimedByName });
    });
  });
});

// admin action: approve -> award points, remove marker
app.post("/markers/:id/approve", verifyFirebaseToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    const idx = markers.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: "Marker not found" });

    const { uploaderUid, claimedByUid } = markers[idx];
    if (uploaderUid) addPoints(uploaderUid, 10);
    if (claimedByUid) addPoints(claimedByUid, 10);

    markers.splice(idx, 1); // delete marker (and image reference)
    writeDatabase(markers, (writeErr) => {
      if (writeErr) return res.status(500).json({ error: "Failed to approve marker" });
      res.json({ ok: true, awarded: { uploaderUid, claimedByUid } });
    });
  });
});

// admin action: reject -> revert to open
app.post("/markers/:id/reject", verifyFirebaseToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  readDatabase((err, markers) => {
    if (err) return res.status(500).json({ error: "Failed to read database" });
    const idx = markers.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: "Marker not found" });
    markers[idx].status = "open";
    markers[idx].claimedByUid = null;
    markers[idx].claimedByName = null;
    writeDatabase(markers, (writeErr) => {
      if (writeErr) return res.status(500).json({ error: "Failed to reject marker" });
      res.json({ id, status: "open" });
    });
  });
});

// optional: check points
app.get("/points/:uid", (req, res) => {
  const table = readJson(pointsFilePath, {});
  res.json({ uid: req.params.uid, points: table[req.params.uid] || 0 });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

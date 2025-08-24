// 새로운 index.js 전체 코드
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // 이미지 크기를 고려해 용량 제한을 늘립니다.

const dbFilePath = path.join(__dirname, "database.json");

// 데이터베이스 파일을 읽는 함수
const readDatabase = (callback) => {
    fs.readFile(dbFilePath, "utf8", (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') { // 파일이 없으면
                return callback(null, []); // 빈 배열 반환
            }
            return callback(err);
        }
        try {
            const markers = JSON.parse(data);
            callback(null, markers);
        } catch (parseErr) {
            callback(parseErr);
        }
    });
};

// 데이터베이스 파일을 쓰는 함수
const writeDatabase = (data, callback) => {
    fs.writeFile(dbFilePath, JSON.stringify(data, null, 2), "utf8", callback);
};

// GET /markers: 모든 마커 가져오기
app.get("/markers", (req, res) => {
    readDatabase((err, markers) => {
        if (err) return res.status(500).json({ error: "Failed to read database" });
        res.json(markers);
    });
});

// POST /markers: 새 마커 추가하기
app.post("/markers", (req, res) => {
    const newMarker = req.body;
    // ✅ 각 마커에 고유한 ID를 부여합니다. (현재 시간을 문자열로 사용)
    newMarker.id = Date.now().toString();

    readDatabase((err, markers) => {
        if (err) return res.status(500).json({ error: "Failed to read database" });
        
        markers.push(newMarker);
        
        writeDatabase(markers, (writeErr) => {
            if (writeErr) return res.status(500).json({ error: "Failed to save marker" });
            res.status(201).json(newMarker);
        });
    });
});

// ✅ DELETE /markers/:id : 특정 ID의 마커 삭제하기 (새로 추가된 부분)
app.delete("/markers/:id", (req, res) => {
    const markerId = req.params.id;

    readDatabase((err, markers) => {
        if (err) return res.status(500).json({ error: "Failed to read database" });

        // 삭제할 ID를 제외한 나머지 마커들만 남깁니다.
        const filteredMarkers = markers.filter(marker => marker.id !== markerId);

        // 마커 개수에 변화가 없으면, 해당 ID가 없었다는 뜻입니다.
        if (markers.length === filteredMarkers.length) {
            return res.status(404).json({ error: "Marker not found" });
        }

        writeDatabase(filteredMarkers, (writeErr) => {
            if (writeErr) return res.status(500).json({ error: "Failed to delete marker" });
            res.status(200).json({ message: "Marker deleted successfully" });
        });
    });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

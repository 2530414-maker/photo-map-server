// 새로운 index.js 전체 코드
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const dbFilePath = path.join(__dirname, "database.json");

const readDatabase = (callback) => {
    fs.readFile(dbFilePath, "utf8", (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') return callback(null, []);
            return callback(err);
        }
        try {
            callback(null, JSON.parse(data));
        } catch (parseErr) {
            callback(parseErr);
        }
    });
};

const writeDatabase = (data, callback) => {
    fs.writeFile(dbFilePath, JSON.stringify(data, null, 2), "utf8", callback);
};

app.get("/markers", (req, res) => {
    readDatabase((err, markers) => {
        if (err) return res.status(500).json({ error: "Failed to read database" });
        res.json(markers);
    });
});

app.post("/markers", (req, res) => {
    const { lat, lon, imgUrl, category } = req.body; // category를 받음
    const newMarker = {
        id: Date.now().toString(),
        lat,
        lon,
        imgUrl,
        category: category || '분류 안됨' // category가 없으면 기본값 설정
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

app.delete("/markers/:id", (req, res) => {
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

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

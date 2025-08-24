// server.js 대신 index.js에 이 코드를 붙여넣으세요.
const express = require("express");
const cors = require("cors");
const fs = require("fs");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" })); // 10MB 용량 제한

const dbFilePath = "./database.json";

// API 1: 저장된 모든 마커 정보 보내주기
app.get("/markers", (req, res) => {
  fs.readFile(dbFilePath, "utf8", (err, data) => {
    if (err) return res.status(500).send("Error reading database");
    res.json(JSON.parse(data));
  });
});

// API 2: 새 마커 정보 받아서 저장하기
app.post("/markers", (req, res) => {
  const newMarker = req.body;
  fs.readFile(dbFilePath, "utf8", (err, data) => {
    if (err) return res.status(500).send("Error reading database");
    const markers = JSON.parse(data);
    markers.push(newMarker);
    fs.writeFile(dbFilePath, JSON.stringify(markers, null, 2), (err) => {
      if (err) return res.status(500).send("Error writing to database");
      res.status(201).json(newMarker);
    });
  });
});

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});

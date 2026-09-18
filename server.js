const express = require("express");
const multer = require("multer");
const axios = require("axios");
const cors = require("cors");

const app = express();
const upload = multer({
  storage: multer.memoryStorage()
});

const PORT = process.env.PORT || 3000;
const PIXELDRAIN_KEY = (process.env.PIXELDRAIN_KEY || "").trim();
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ||
  `https://${process.env.RENDER_EXTERNAL_HOSTNAME || ""}`
).replace(/\/+$/, "");

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Origin",
    "Content-Type",
    "Accept",
    "Authorization",
    "Range"
  ],
  exposedHeaders: [
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "Content-Disposition",
    "Content-Type"
  ]
}));

app.options("*", cors());
app.use(express.json());

function pixeldrainAuth() {
  return `Basic ${Buffer.from(`:${PIXELDRAIN_KEY}`).toString("base64")}`;
}

function requirePixeldrainKey(res) {
  if (!PIXELDRAIN_KEY) {
    res.status(500).json({
      success: false,
      error: "PIXELDRAIN_KEY is not configured on the server."
    });
    return false;
  }

  return true;
}

function getProxyUrl(fileId) {
  return `${PUBLIC_BASE_URL}/stream/${encodeURIComponent(fileId)}`;
}

function getPixeldrainError(response) {
  const data = response?.data;

  if (data && typeof data.on === "function") {
    return `Pixeldrain returned HTTP ${response.status}. Check the Render logs and Pixeldrain API key.`;
  }

  if (typeof data === "string") return data.slice(0, 300);
  if (data?.message) return data.message;
  if (data?.error) return data.error;

  return `Pixeldrain returned HTTP ${response?.status || "an error"}.`;
}

app.get("/", (_req, res) => {
  res.json({
    status: "Wohoo Cloud Proxy running",
    pixeldrain: PIXELDRAIN_KEY ? "configured" : "missing key",
    publicUrl: PUBLIC_BASE_URL || "missing PUBLIC_BASE_URL"
  });
});

// Upload a file to Pixeldrain.
// POST /upload with multipart field: file
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!requirePixeldrainKey(res)) return;

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "No file provided."
    });
  }

  try {
    const encodedFilename = encodeURIComponent(req.file.originalname);
    const response = await axios.put(
      `https://pixeldrain.com/api/file/${encodedFilename}`,
      req.file.buffer,
      {
        headers: {
          Authorization: pixeldrainAuth(),
          "Content-Type": req.file.mimetype || "application/octet-stream",
          "Content-Length": req.file.size
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 180000
      }
    );

    const fileId = response.data?.id;
    if (!fileId) {
      return res.status(502).json({
        success: false,
        error: "Pixeldrain did not return a file ID."
      });
    }

    const proxyUrl = getProxyUrl(fileId);

    return res.status(201).json({
      success: true,
      id: fileId,
      url: proxyUrl,
      streamUrl: proxyUrl,
      name: req.file.originalname,
      fileName: req.file.originalname,
      size: req.file.size,
      mimeType: req.file.mimetype || "application/octet-stream"
    });
  } catch (error) {
    console.error(
      "Pixeldrain upload error:",
      error.response?.status,
      error.response?.data || error.message
    );

    const status = error.response?.status || 500;
    const message =
      error.response?.data?.message ||
      error.response?.data?.error ||
      error.message ||
      "Upload failed.";

    return res.status(status).json({
      success: false,
      error: message
    });
  }
});

// Stream/download a file through Render.
// GET /stream/:id
app.get("/stream/:id", async (req, res) => {
  if (!requirePixeldrainKey(res)) return;

  const fileId = decodeURIComponent(req.params.id);
  const requestHeaders = {
    Authorization: pixeldrainAuth()
  };

  if (req.headers.range) {
    requestHeaders.Range = req.headers.range;
  }

  try {
    const response = await axios.get(
      `https://pixeldrain.com/api/file/${encodeURIComponent(fileId)}`,
      {
        headers: requestHeaders,
        responseType: "stream",
        validateStatus: () => true,
        timeout: 180000
      }
    );

    if (response.status < 200 || response.status >= 300) {
      console.error(
        "Pixeldrain download error:",
        response.status,
        response.statusText,
        response.headers
      );

      // Do not pipe an error response body to the browser.
      if (response.data && typeof response.data.destroy === "function") {
        response.data.destroy();
      }

      return res.status(response.status).json({
        success: false,
        error: getPixeldrainError(response)
      });
    }

    const contentType =
      response.headers["content-type"] ||
      "application/octet-stream";

    res.status(response.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader(
      "Accept-Ranges",
      response.headers["accept-ranges"] || "bytes"
    );

    if (response.headers["content-length"]) {
      res.setHeader("Content-Length", response.headers["content-length"]);
    }

    if (response.headers["content-range"]) {
      res.setHeader("Content-Range", response.headers["content-range"]);
    }

    response.data.on("error", error => {
      console.error("Pixeldrain stream error:", error.message);
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          error: "The file stream was interrupted."
        });
      } else {
        res.end();
      }
    });

    return response.data.pipe(res);
  } catch (error) {
    console.error("Proxy download error:", error.message);

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: "Could not download the file through the proxy."
      });
    }

    return res.end();
  }
});

// Delete a file from Pixeldrain.
// DELETE /file/:id
app.delete("/file/:id", async (req, res) => {
  if (!requirePixeldrainKey(res)) return;

  const fileId = decodeURIComponent(req.params.id);

  try {
    await axios.delete(
      `https://pixeldrain.com/api/file/${encodeURIComponent(fileId)}`,
      {
        headers: {
          Authorization: pixeldrainAuth()
        },
        timeout: 60000
      }
    );

    return res.json({ success: true });
  } catch (error) {
    console.error(
      "Pixeldrain delete error:",
      error.response?.status,
      error.response?.data || error.message
    );

    const status = error.response?.status || 500;
    return res.status(status).json({
      success: false,
      error:
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        "Delete failed."
    });
  }
});

app.use((error, _req, res, _next) => {
  console.error("Server error:", error);
  res.status(500).json({
    success: false,
    error: "Internal server error."
  });
});

app.listen(PORT, () => {
  console.log(`Wohoo Cloud Proxy running on port ${PORT}`);
  console.log(`Public proxy URL: ${PUBLIC_BASE_URL || "not configured"}`);
});


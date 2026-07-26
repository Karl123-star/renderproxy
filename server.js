const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const cors = require('cors');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3000;
const PD_KEY = process.env.PIXELDRAIN_KEY || '';

// Allow all origins — your Folio app will call this
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// ── Health check ──
app.get('/', (req, res) => {
  res.json({ status: 'Folio Proxy running', pixeldrain: PD_KEY ? 'configured' : 'missing key' });
});

// ── UPLOAD FILE TO PIXELDRAIN ──
// POST /upload with multipart form: field "file"
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  try {
    const filename = encodeURIComponent(req.file.originalname);
    const auth = Buffer.from(':' + PD_KEY).toString('base64');

    const response = await axios.put(
      `https://pixeldrain.com/api/file/${filename}`,
      req.file.buffer,
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': req.file.mimetype,
          'Content-Length': req.file.size
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }
    );

    const fileId = response.data.id;
    res.json({
      success: true,
      id: fileId,
      viewUrl: `https://pixeldrain.com/u/${fileId}`,
      directLink: `https://pixeldrain.com/api/file/${fileId}`,
      name: req.file.originalname,
      size: req.file.size
    });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'Upload failed';
    res.status(500).json({ success: false, error: msg });
  }
});

// ── DELETE FILE FROM PIXELDRAIN ──
// DELETE /file/:id
app.delete('/file/:id', async (req, res) => {
  try {
    const auth = Buffer.from(':' + PD_KEY).toString('base64');
    await axios.delete(`https://pixeldrain.com/api/file/${req.params.id}`, {
      headers: { 'Authorization': `Basic ${auth}` }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PROXY DOWNLOAD (for video streaming in-app) ──
// GET /stream/:id
app.get('/stream/:id', async (req, res) => {
  try {
    const auth = Buffer.from(':' + PD_KEY).toString('base64');
    const response = await axios.get(
      `https://pixeldrain.com/api/file/${req.params.id}`,
      {
        headers: { 'Authorization': `Basic ${auth}` },
        responseType: 'stream'
      }
    );
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    response.data.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Folio Proxy running on port ${PORT}`));

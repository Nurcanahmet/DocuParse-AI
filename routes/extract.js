const express = require('express');
const multer = require('multer');
const Groq = require('groq-sdk');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const { parse: csvParse } = require('csv-parse/sync');
const router = express.Router();

const ALLOWED_TYPES = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'text/html': 'html',
  'text/plain': 'txt'
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase();
    const allowed = ['pdf','xlsx','xls','csv','html','htm'];
    if (ALLOWED_TYPES[file.mimetype] || allowed.includes(ext)) cb(null, true);
    else cb(new Error('Desteklenmeyen dosya türü. PDF, Excel, CSV veya HTML yükleyin.'));
  }
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function extractText(file) {
  const ext = file.originalname.split('.').pop().toLowerCase();

  if (ext === 'pdf') {
    const data = await pdfParse(file.buffer);
    return { text: data.text, pages: data.numpages, type: 'pdf' };
  }

  if (['xlsx', 'xls'].includes(ext)) {
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    let text = '';
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      text += `=== Sayfa: ${sheetName} ===\n${csv}\n\n`;
    });
    return { text, pages: workbook.SheetNames.length, type: 'excel', sheets: workbook.SheetNames };
  }

  if (ext === 'csv') {
    const text = file.buffer.toString('utf-8');
    return { text, pages: 1, type: 'csv' };
  }

  if (['html', 'htm'].includes(ext)) {
    const raw = file.buffer.toString('utf-8');
    const text = raw
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { text, pages: 1, type: 'html' };
  }

  throw new Error('Desteklenmeyen dosya türü.');
}

router.post('/extract', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya gerekli.' });

  const mode = req.body.mode || 'both';

  try {
    const { text, pages, type, sheets } = await extractText(req.file);

    if (!text || text.trim().length < 5) {
      return res.status(400).json({ error: 'Dosyadan metin çıkarılamadı.' });
    }

    const prompt = `Aşağıdaki ${type.toUpperCase()} dosyası içeriğini analiz et ve tüm tablo ve yapılandırılmış verileri çıkar.

DOSYA İÇERİĞİ:
${text.substring(0, 14000)}

Yanıtını SADECE aşağıdaki JSON formatında ver, başka hiçbir şey yazma:

{
  "tables": [
    {
      "title": "Tablo başlığı",
      "page": 1,
      "headers": ["Sütun1", "Sütun2"],
      "rows": [["değer1", "değer2"]]
    }
  ],
  "structured_data": { "anahtar": "değer" },
  "summary": "Dosya içeriğinin kısa Türkçe özeti (2-3 cümle)",
  "total_tables": 0,
  "total_rows": 0
}`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
      temperature: 0.1
    });

    const rawText = completion.choices[0]?.message?.content || '';
    const clean = rawText.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error('AI yanıtı JSON formatında değil.');
    }

    parsed.total_tables = parsed.tables?.length || 0;
    parsed.total_rows = (parsed.tables || []).reduce((s, t) => s + (t.rows?.length || 0), 0);
    parsed.filename = req.file.originalname;
    parsed.filesize = req.file.size;
    parsed.filetype = type;
    parsed.pages = pages;
    if (sheets) parsed.sheets = sheets;

    res.json({ success: true, data: parsed });

  } catch (err) {
    console.error('Hata:', err.message);
    res.status(500).json({ error: err.message || 'Sunucu hatası.' });
  }
});

router.use((err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

module.exports = router;

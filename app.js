var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var fs = require('fs');
const multer = require("multer");
const cors = require('cors');

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');

var { PDFToImage } = require('pdf-to-image-generator');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');

var app = express();

// =======================
// View engine setup
// =======================
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/users', usersRouter);

// =======================
// Utils
// =======================
function ensureFolder(folderPath) {
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
}

function cleanFolder(folderPath) {
  if (!fs.existsSync(folderPath)) return;
  fs.readdirSync(folderPath).forEach(file => {
    fs.unlinkSync(path.join(folderPath, file));
  });
}

app.use(cors());

// ensure uploads folder exists (never delete)
ensureFolder('uploads');

// =======================
// Multer storage
// =======================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '.pdf');
  }
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') cb(null, true);
  else cb(new Error('Only PDF allowed ❌'), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

// =======================
// PDF → Image
// =======================
async function convertPDF(pdfPath, tempFolder) {
  try {
    ensureFolder(tempFolder);
    cleanFolder(tempFolder);

    const options = { outputFolderName: tempFolder, viewportScale: 2 };
    const pdf = await new PDFToImage().load(pdfPath);
    console.log('Total Pages:', pdf.document.numPages);
    await pdf.convert(options);
    console.log('PDF → Image done');
  } catch (err) {
    console.error('PDF convert error:', err);
    throw err;
  }
}

// =======================
// Stage 1 → negate + grayscale + dark
// =======================
async function stageOne(inputFolder, stageFolder) {
  ensureFolder(stageFolder);
  cleanFolder(stageFolder);

  const files = fs.readdirSync(inputFolder).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
  if (files.length === 0) return;

  for (const file of files) {
    await sharp(path.join(inputFolder, file))
      .grayscale()
      .negate()
      .linear(1.3, -50)
      .toFile(path.join(stageFolder, file));
    console.log('Stage 1 done:', file);
  }
}

// =======================
// Stage 2 → negate only + dark
// =======================
async function stageTwo(stage1Folder, stage2Folder) {
  ensureFolder(stage2Folder);
  cleanFolder(stage2Folder);

  const files = fs.readdirSync(stage1Folder).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
  if (files.length === 0) return;

  for (const file of files) {
    await sharp(path.join(stage1Folder, file))
      .negate()
      .linear(1.2, -30)
      .toFile(path.join(stage2Folder, file));
    console.log('Stage 2 done:', file);
  }
}

// =======================
// Stage 3 → MainFinalOutput
// =======================
async function mainFinalOutput(stage2Folder, finalFolder) {
  ensureFolder(finalFolder);
  cleanFolder(finalFolder);

  const files = fs.readdirSync(stage2Folder).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
  if (files.length === 0) return;

  for (const file of files) {
    await sharp(path.join(stage2Folder, file))
      .negate()
      .linear(1.5, -30)
      .toFile(path.join(finalFolder, file));
    console.log('MainFinalOutput done:', file);
  }

  // Cleanup Stage2
  fs.rmSync(stage2Folder, { recursive: true, force: true });
  console.log('Stage 2 deleted');
}

// =======================
// Cleanup stage folders only
// =======================
function cleanupTempFolders(folders) {
  folders.forEach(folder => {
    if (fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true });
      console.log(`${folder} deleted`);
    }
  });
}

// =======================
// PDF layout
// =======================
const A4_WIDTH = 595;
const A4_HEIGHT = 842;
const COLS_DEFAULT = 2;
const ROWS_DEFAULT = 4;
const MAX_COLS = 10;
const MAX_ROWS = 20;

// =======================
// Create PDF from images
// =======================
async function createPDFfromImages(finalFolder, cols = COLS_DEFAULT, rows = ROWS_DEFAULT) {
  const outputPDF = path.join(__dirname, 'FinalOutput.pdf');
  const files = fs.readdirSync(finalFolder).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f)).sort();
  if (files.length === 0) return;

  const IMAGE_WIDTH = A4_WIDTH / cols;
  const IMAGE_HEIGHT = (A4_HEIGHT / rows) * 0.9;
  const PADDING = 4;

  const doc = new PDFDocument({ autoFirstPage: false });
  doc.pipe(fs.createWriteStream(outputPDF));

  let x = 0, y = 0, count = 0;

  for (const file of files) {
    const imgPath = path.join(finalFolder, file);
    if (count % (cols * rows) === 0) {
      doc.addPage({ size: [A4_WIDTH, A4_HEIGHT] });
      x = 0; y = 0;
    }

    try {
      doc.image(imgPath, x + PADDING, y + PADDING, { fit: [IMAGE_WIDTH - 2 * PADDING, IMAGE_HEIGHT - 2 * PADDING] });
    } catch (err) {
      console.warn('Fallback image draw:', imgPath, err);
      doc.image(imgPath, x, y, { width: IMAGE_WIDTH, height: IMAGE_HEIGHT });
    }

    // border & slide number
    doc.save();
    doc.lineWidth(1);
    doc.strokeColor('black');
    doc.rect(x, y, IMAGE_WIDTH, IMAGE_HEIGHT).stroke();
    doc.restore();

    doc.fontSize(6).fillColor('black').text((count + 1).toString(), x + IMAGE_WIDTH - 15, y + IMAGE_HEIGHT - 15);

    x += IMAGE_WIDTH;
    if ((count + 1) % cols === 0) { x = 0; y += IMAGE_HEIGHT; }
    count++;
  }

  doc.end();
  console.log('✅ PDF created at:', outputPDF);
}

// =======================
// Main pipeline
// =======================
async function main(pdfPath, row, column) {
  const tempUpload = path.join(__dirname, 'upload');
  const stage1Folder = path.join(__dirname, 'stage_1');
  const stage2Folder = path.join(__dirname, 'stage_2');
  const finalFolder = path.join(__dirname, 'MainFinalOutput');

  // recreate folders for this run
  [tempUpload, stage1Folder, stage2Folder, finalFolder].forEach(f => ensureFolder(f));

  await convertPDF(pdfPath, tempUpload);
  await stageOne(tempUpload, stage1Folder);
  await stageTwo(stage1Folder, stage2Folder);
  await mainFinalOutput(stage2Folder, finalFolder);

  // Layout
  let cols = COLS_DEFAULT;
  let rows = ROWS_DEFAULT;
  const parsedCol = parseInt(column, 10);
  const parsedRow = parseInt(row, 10);
  if (Number.isInteger(parsedCol) && parsedCol >= 1 && parsedCol <= MAX_COLS) cols = parsedCol;
  if (Number.isInteger(parsedRow) && parsedRow >= 1 && parsedRow <= MAX_ROWS) rows = parsedRow;

  console.log(`Generating PDF with layout ${rows} rows x ${cols} cols`);
  await createPDFfromImages(finalFolder, cols, rows);

  cleanupTempFolders([stage1Folder, stage2Folder, finalFolder, tempUpload]);
  console.log('🔥 ALL STAGES DONE');
}

// ===== Serve frontend =====
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ===== POST API =====
app.post(
  '/api/process-pdf',
  (req, res, next) => {
    upload.single('pdf')(req, res, err => {
      if (err) {
        let message = err instanceof multer.MulterError ? err.message : err.message;
        return res.status(400).json({ details: message });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ details: 'No PDF uploaded ❌' });
      const row = req.body.row, column = req.body.column;
      await main(req.file.path, row, column);

      const finalPDF = path.join(__dirname, 'FinalOutput.pdf');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="FinalOutput.pdf"');
      fs.createReadStream(finalPDF).pipe(res);

    } catch (err) {
      console.error('Processing error:', err);
      res.status(500).json({ details: err.message || 'PDF processing failed ❌' });
    }
  }
);

// ===== Generic Error Handler =====
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ details: err.message || 'Something went wrong ❌' });
});

module.exports = app;

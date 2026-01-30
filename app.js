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


// ensure uploads folder exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '.pdf');
  }
});

// only pdf filter
const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF allowed ❌'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024 // 10MB
  }
});


// =======================
// PDF → Image
// =======================
async function convertPDF(pdfPath) {
  try {
    const uploadFolder = path.join(__dirname, 'upload');

    ensureFolder(uploadFolder);
    cleanFolder(uploadFolder);

    const options = {
      outputFolderName: 'upload',
      viewportScale: 2
    };

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
async function stageOne() {
  const inputFolder = path.join(__dirname, 'upload');
  const stage1 = path.join(__dirname, 'stage_1');

  ensureFolder(stage1);
  cleanFolder(stage1);

  const files = fs.readdirSync(inputFolder);

  for (const file of files) {
    if (!/\.(png|jpg|jpeg|webp)$/i.test(file)) continue;

    await sharp(path.join(inputFolder, file))
      .grayscale()
      .negate()
      .linear(1.3, -50) // dark + contrast
      .toFile(path.join(stage1, file));

    console.log('Stage 1 done (dark + contrast):', file);
  }
}

// =======================
// Stage 2 → negate only + dark
// =======================
async function stageTwo() {
  const stage1 = path.join(__dirname, 'stage_1');
  const stage2 = path.join(__dirname, 'stage_2');

  ensureFolder(stage2);
  cleanFolder(stage2);

  const files = fs.readdirSync(stage1);

  for (const file of files) {
    if (!/\.(png|jpg|jpeg|webp)$/i.test(file)) continue;

    await sharp(path.join(stage1, file))
      .negate()
      .linear(1.2, -30) // dark + contrast
      .toFile(path.join(stage2, file));

    console.log('Stage 2 done (dark + contrast):', file);
  }
}

// =======================
// Stage 3 → MainFinalOutput → negate only + dark
// =======================
async function mainFinalOutput() {
  const stage2 = path.join(__dirname, 'stage_2');
  const finalOutput = path.join(__dirname, 'MainFinalOutput');

  ensureFolder(finalOutput);
  cleanFolder(finalOutput);

  const files = fs.readdirSync(stage2);

  for (const file of files) {
    if (!/\.(png|jpg|jpeg|webp)$/i.test(file)) continue;

    await sharp(path.join(stage2, file))
      .negate()
      .linear(1.5, -30) // dark + contrast
      .toFile(path.join(finalOutput, file));

    console.log('MainFinalOutput done (dark + contrast):', file);
  }

  // Cleanup Stage 2
  if (fs.existsSync(stage2)) {
    fs.rmSync(stage2, { recursive: true, force: true });
    console.log('Stage 2 deleted, only MainFinalOutput remains');
  }
}

// =======================
// Cleanup Stage 1 + Upload
// =======================
function cleanupTempFolders() {
  const stage1 = path.join(__dirname, 'stage_1');
  const upload = path.join(__dirname, 'upload');
  const MainFinalOutput = path.join(__dirname, 'MainFinalOutput');
  const uploads = path.join(__dirname, 'uploads');

  [stage1, upload , MainFinalOutput, uploads].forEach(folder => {
    if (fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true });
      console.log(`${path.basename(folder)} deleted`);
    }
  });
}

// =======================
// ===== A4 PDF layout =====
const A4_WIDTH = 595;
const A4_HEIGHT = 842;
const COLS = 2;
const ROWS = 4;
const IMAGE_WIDTH = A4_WIDTH / COLS;
const IMAGE_HEIGHT = (A4_HEIGHT / ROWS) * 0.9;

// =======================
// Footer text (every page bottom)
// =======================
const footerText = "Your footer text here";

// =======================
// Create PDF from MainFinalOutput
// =======================
async function createPDFfromImages() {
  const finalOutput = path.join(__dirname, 'MainFinalOutput');
  const outputPDF = path.join(__dirname, 'FinalOutput.pdf');

  const files = fs.readdirSync(finalOutput)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .sort();

  if (files.length === 0) {
    console.log('No images found in MainFinalOutput to create PDF');
    return;
  }

  const doc = new PDFDocument({ autoFirstPage: false });
  doc.pipe(fs.createWriteStream(outputPDF));

  let x = 0, y = 0, count = 0, pageNum = 1;

  for (const file of files) {
    const imgPath = path.join(finalOutput, file);

    // new page if needed
    if (count % (COLS * ROWS) === 0) {
      doc.addPage({ size: [A4_WIDTH, A4_HEIGHT] });
      x = 0;
      y = 0;
    }

    // Add image
    doc.image(imgPath, x, y, { width: IMAGE_WIDTH, height: IMAGE_HEIGHT });

    // Add 1px border
    doc.save();
    doc.lineWidth(1);
    doc.strokeColor('black');
    doc.rect(x, y, IMAGE_WIDTH, IMAGE_HEIGHT).stroke();
    doc.restore();

    // Bottom-right per-slide number
    const slideNum = count + 1;
    doc.fontSize(6)
       .fillColor('black')
       .text(slideNum.toString(), x + IMAGE_WIDTH - 15, y + IMAGE_HEIGHT - 15);

    x += IMAGE_WIDTH;
    if ((count + 1) % COLS === 0) {
      x = 0;
      y += IMAGE_HEIGHT;
    }

   

    count++;
    console.log('Added to PDF:', file);
  }

  doc.end();
  console.log('✅ PDF created at:', outputPDF);
}
async function main(pdfPath) {
  ensureFolder(path.join(__dirname, 'upload'));
  ensureFolder(path.join(__dirname, 'stage_1'));
  ensureFolder(path.join(__dirname, 'stage_2'));
  ensureFolder(path.join(__dirname, 'MainFinalOutput'));

  await convertPDF(pdfPath);
  await stageOne();
  await stageTwo();
  await mainFinalOutput();
  await createPDFfromImages();

  cleanupTempFolders();

  console.log('🔥 ALL STAGES DONE');
}



// ===== Serve frontend =====
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
// ===== POST API =====
app.post(
  '/api/process-pdf',
  (req, res, next) => {
    // multer middleware manually call
    upload.single('pdf')(req, res, (err) => {
      if (err) {
        // multer-specific errors
        let message = 'File upload error';
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            message = 'File too large ❌';
          } else {
            message = err.message;
          }
        } else {
          message = err.message;
        }
        return res.status(400).json({ details: message });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ details: 'No PDF uploaded ❌' });
      }

      const uploadedPdfPath = req.file.path;
      console.log('Uploaded PDF:', uploadedPdfPath);

      // Run full pipeline
      await main(uploadedPdfPath);

      const finalPDF = path.join(__dirname, 'FinalOutput.pdf');

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="FinalOutput.pdf"'
      );

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
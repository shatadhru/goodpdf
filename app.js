// =======================
// 1. IMPORT DEPENDENCIES
// =======================
const createError = require('http-errors');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const fs = require('fs').promises;  // Use promise-based API for better async handling
const fsSync = require('fs');       // Keep sync for startup operations only
const multer = require('multer');
const cors = require('cors');

// =======================
// 2. ROUTER IMPORTS
// =======================
const indexRouter = require('./routes/index');
const usersRouter = require('./routes/users');

// =======================
// 3. IMAGE PROCESSING LIBRARIES
// =======================
const { PDFToImage } = require('pdf-to-image-generator');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');

// =======================
// 4. CONSTANT DEFINITIONS
// =======================
// Application constants
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB in bytes
const A4_WIDTH = 595;
const A4_HEIGHT = 842;
const DEFAULT_COLUMNS = 2;
const DEFAULT_ROWS = 4;
const MAX_COLUMNS = 10;
const MAX_ROWS = 20;
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

// Folder paths
const UPLOAD_FOLDER = path.join(__dirname, 'uploads');
const TEMP_UPLOAD_FOLDER = path.join(__dirname, 'upload');
const STAGE_1_FOLDER = path.join(__dirname, 'stage_1');
const STAGE_2_FOLDER = path.join(__dirname, 'stage_2');
const FINAL_FOLDER = path.join(__dirname, 'MainFinalOutput');
const FINAL_PDF_PATH = path.join(__dirname, 'FinalOutput.pdf');

// =======================
// 5. HELPER FUNCTIONS
// =======================

/**
 * Ensures a folder exists by creating it if it doesn't exist
 * @param {string} folderPath - Path to the folder
 */
async function ensureFolderExists(folderPath) {
  try {
    await fs.access(folderPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Folder doesn't exist, create it
      await fs.mkdir(folderPath, { recursive: true });
      console.log(`Created folder: ${folderPath}`);
    } else {
      throw error;
    }
  }
}

/**
 * Safely removes all files from a folder
 * @param {string} folderPath - Path to the folder
 */
async function cleanFolder(folderPath) {
  try {
    const files = await fs.readdir(folderPath);
    
    // Delete all files in parallel for better performance
    const deletePromises = files.map(async (file) => {
      const filePath = path.join(folderPath, file);
      try {
        await fs.unlink(filePath);
      } catch (error) {
        console.warn(`Failed to delete file ${filePath}:`, error.message);
      }
    });
    
    await Promise.all(deletePromises);
    console.log(`Cleaned folder: ${folderPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Failed to clean folder ${folderPath}:`, error.message);
    }
  }
}

/**
 * Safely removes a folder and all its contents
 * @param {string} folderPath - Path to the folder to remove
 */
async function removeFolder(folderPath) {
  try {
    await fs.rm(folderPath, { recursive: true, force: true });
    console.log(`Removed folder: ${folderPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Failed to remove folder ${folderPath}:`, error.message);
    }
  }
}

/**
 * Safely removes a file
 * @param {string} filePath - Path to the file to remove
 */
async function removeFile(filePath) {
  try {
    await fs.unlink(filePath);
    console.log(`Removed file: ${filePath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Failed to remove file ${filePath}:`, error.message);
    }
  }
}

/**
 * Validates if a value is a valid positive integer within range
 * @param {any} value - Value to validate
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @param {number} defaultValue - Default value if invalid
 * @returns {number} Validated integer
 */
function validateInteger(value, min, max, defaultValue) {
  const parsed = parseInt(String(value), 10);
  
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    return defaultValue;
  }
  
  return parsed;
}

/**
 * Filters files by allowed image extensions
 * @param {string[]} files - Array of filenames
 * @returns {string[]} Filtered array of image files
 */
function filterImageFiles(files) {
  return files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    return IMAGE_EXTENSIONS.includes(ext);
  });
}

// =======================
// 6. IMAGE PROCESSING FUNCTIONS
// =======================

/**
 * Converts PDF to images
 * @param {string} pdfPath - Path to the PDF file
 * @param {string} outputFolder - Folder to save converted images
 */
async function convertPdfToImages(pdfPath, outputFolder) {
  try {
    // Ensure output folder exists and is clean
    await ensureFolderExists(outputFolder);
    await cleanFolder(outputFolder);
    
    const options = { 
      outputFolderName: outputFolder, 
      viewportScale: 2 
    };
    
    const pdf = await new PDFToImage().load(pdfPath);
    console.log(`Processing PDF with ${pdf.document.numPages} pages`);
    
    await pdf.convert(options);
    console.log('PDF converted to images successfully');
    
  } catch (error) {
    console.error('PDF conversion error:', error);
    throw new Error(`Failed to convert PDF: ${error.message}`);
  }
}

/**
 * Applies stage 1 image processing (grayscale, negate, darken)
 * @param {string} inputFolder - Folder containing input images
 * @param {string} outputFolder - Folder to save processed images
 */
async function applyStageOneProcessing(inputFolder, outputFolder) {
  try {
    await ensureFolderExists(outputFolder);
    await cleanFolder(outputFolder);
    
    const files = await fs.readdir(inputFolder);
    const imageFiles = filterImageFiles(files);
    
    if (imageFiles.length === 0) {
      console.log('No images found for stage 1 processing');
      return;
    }
    
    console.log(`Processing ${imageFiles.length} images in stage 1`);
    
    // Process each image
    for (const file of imageFiles) {
      const inputPath = path.join(inputFolder, file);
      const outputPath = path.join(outputFolder, file);
      
      await sharp(inputPath)
        .grayscale()           // Convert to grayscale
        .negate()              // Invert colors
        .linear(1.3, -50)      // Adjust brightness and darkness
        .toFile(outputPath);
      
      console.log(`Stage 1 processed: ${file}`);
    }
    
  } catch (error) {
    console.error('Stage 1 processing error:', error);
    throw new Error(`Stage 1 processing failed: ${error.message}`);
  }
}

/**
 * Applies stage 2 image processing (negate and darken)
 * @param {string} inputFolder - Folder containing stage 1 images
 * @param {string} outputFolder - Folder to save stage 2 images
 */
async function applyStageTwoProcessing(inputFolder, outputFolder) {
  try {
    await ensureFolderExists(outputFolder);
    await cleanFolder(outputFolder);
    
    const files = await fs.readdir(inputFolder);
    const imageFiles = filterImageFiles(files);
    
    if (imageFiles.length === 0) {
      console.log('No images found for stage 2 processing');
      return;
    }
    
    console.log(`Processing ${imageFiles.length} images in stage 2`);
    
    for (const file of imageFiles) {
      const inputPath = path.join(inputFolder, file);
      const outputPath = path.join(outputFolder, file);
      
      await sharp(inputPath)
        .negate()              // Invert colors
        .linear(1.2, -30)      // Adjust brightness
        .toFile(outputPath);
      
      console.log(`Stage 2 processed: ${file}`);
    }
    
  } catch (error) {
    console.error('Stage 2 processing error:', error);
    throw new Error(`Stage 2 processing failed: ${error.message}`);
  }
}

/**
 * Applies final stage image processing
 * @param {string} inputFolder - Folder containing stage 2 images
 * @param {string} outputFolder - Folder to save final images
 */
async function applyFinalProcessing(inputFolder, outputFolder) {
  try {
    await ensureFolderExists(outputFolder);
    await cleanFolder(outputFolder);
    
    const files = await fs.readdir(inputFolder);
    const imageFiles = filterImageFiles(files);
    
    if (imageFiles.length === 0) {
      console.log('No images found for final processing');
      return;
    }
    
    console.log(`Processing ${imageFiles.length} images in final stage`);
    
    for (const file of imageFiles) {
      const inputPath = path.join(inputFolder, file);
      const outputPath = path.join(outputFolder, file);
      
      await sharp(inputPath)
        .negate()              // Invert colors
        .linear(1.5, -30)      // Adjust brightness
        .toFile(outputPath);
      
      console.log(`Final stage processed: ${file}`);
    }
    
  } catch (error) {
    console.error('Final processing error:', error);
    throw new Error(`Final processing failed: ${error.message}`);
  }
}

/**
 * Creates PDF from processed images
 * @param {string} imagesFolder - Folder containing final images
 * @param {number} columns - Number of columns in the grid
 * @param {number} rows - Number of rows in the grid
 */
async function createPdfFromImages(imagesFolder, columns, rows) {
  try {
    const files = await fs.readdir(imagesFolder);
    const imageFiles = filterImageFiles(files);
    
    if (imageFiles.length === 0) {
      throw new Error('No images found to create PDF');
    }
    
    // Sort files to maintain order
    imageFiles.sort();
    
    const imageWidth = A4_WIDTH / columns;
    const imageHeight = (A4_HEIGHT / rows) * 0.9; // 90% of row height for spacing
    const padding = 4;
    
    // Create a new PDF document
    const pdfDocument = new PDFDocument({ autoFirstPage: false });
    const writeStream = fsSync.createWriteStream(FINAL_PDF_PATH);
    
    pdfDocument.pipe(writeStream);
    
    let currentX = 0;
    let currentY = 0;
    let imageCount = 0;
    
    for (const file of imageFiles) {
      // Add new page when current one is full
      if (imageCount % (columns * rows) === 0) {
        pdfDocument.addPage({ size: [A4_WIDTH, A4_HEIGHT] });
        currentX = 0;
        currentY = 0;
      }
      
      const imagePath = path.join(imagesFolder, file);
      
      try {
        // Add image to PDF with padding
        pdfDocument.image(
          imagePath,
          currentX + padding,
          currentY + padding,
          {
            fit: [imageWidth - 2 * padding, imageHeight - 2 * padding]
          }
        );
      } catch (imageError) {
        console.warn(`Using fallback for image: ${file}`, imageError.message);
        // Fallback method if the first approach fails
        pdfDocument.image(imagePath, currentX, currentY, {
          width: imageWidth,
          height: imageHeight
        });
      }
      
      // Draw border around image
      pdfDocument.save();
      pdfDocument.lineWidth(1);
      pdfDocument.strokeColor('black');
      pdfDocument.rect(currentX, currentY, imageWidth, imageHeight).stroke();
      pdfDocument.restore();
      
      // Add page number
      pdfDocument.fontSize(6)
        .fillColor('black')
        .text(
          (imageCount + 1).toString(),
          currentX + imageWidth - 15,
          currentY + imageHeight - 15
        );
      
      // Move to next position
      currentX += imageWidth;
      if ((imageCount + 1) % columns === 0) {
        currentX = 0;
        currentY += imageHeight;
      }
      
      imageCount++;
    }
    
    pdfDocument.end();
    
    // Wait for PDF to finish writing
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
    
    console.log(`PDF created successfully with ${imageCount} images`);
    
  } catch (error) {
    console.error('PDF creation error:', error);
    throw new Error(`Failed to create PDF: ${error.message}`);
  }
}

/**
 * Main processing pipeline
 * @param {string} pdfFilePath - Path to uploaded PDF file
 * @param {string} rowParam - Rows parameter from request
 * @param {string} columnParam - Columns parameter from request
 */
async function processPdfPipeline(pdfFilePath, rowParam, columnParam) {
  console.log('Starting PDF processing pipeline...');
  
  try {
    // Step 1: Convert PDF to images
    console.log('Step 1: Converting PDF to images');
    await convertPdfToImages(pdfFilePath, TEMP_UPLOAD_FOLDER);
    
    // Step 2: Apply stage 1 processing
    console.log('Step 2: Applying stage 1 processing');
    await applyStageOneProcessing(TEMP_UPLOAD_FOLDER, STAGE_1_FOLDER);
    
    // Step 3: Apply stage 2 processing
    console.log('Step 3: Applying stage 2 processing');
    await applyStageTwoProcessing(STAGE_1_FOLDER, STAGE_2_FOLDER);
    
    // Step 4: Apply final processing
    console.log('Step 4: Applying final processing');
    await applyFinalProcessing(STAGE_2_FOLDER, FINAL_FOLDER);
    
    // Step 5: Validate and set layout parameters
    const columns = validateInteger(columnParam, 1, MAX_COLUMNS, DEFAULT_COLUMNS);
    const rows = validateInteger(rowParam, 1, MAX_ROWS, DEFAULT_ROWS);
    
    console.log(`Step 5: Creating PDF with ${rows} rows x ${columns} columns`);
    
    // Step 6: Create final PDF
    await createPdfFromImages(FINAL_FOLDER, columns, rows);
    
    // Step 7: Clean up temporary folders
    console.log('Step 7: Cleaning up temporary folders');
    await Promise.all([
      removeFolder(TEMP_UPLOAD_FOLDER),
      removeFolder(STAGE_1_FOLDER),
      removeFolder(STAGE_2_FOLDER),
      removeFolder(FINAL_FOLDER)
    ]);
    
    console.log('PDF processing pipeline completed successfully');
    
  } catch (error) {
    // Attempt to clean up on error
    console.error('Pipeline error, attempting cleanup...');
    await Promise.all([
      removeFolder(TEMP_UPLOAD_FOLDER).catch(() => {}),
      removeFolder(STAGE_1_FOLDER).catch(() => {}),
      removeFolder(STAGE_2_FOLDER).catch(() => {}),
      removeFolder(FINAL_FOLDER).catch(() => {})
    ]);
    
    throw error; // Re-throw for caller to handle
  }
}

// =======================
// 7. EXPRESS APPLICATION SETUP
// =======================
const app = express();

// Set up view engine (Jade/Pug)
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

// =======================
// 8. MIDDLEWARE
// =======================
app.use(logger('dev')); // Log HTTP requests
app.use(express.json()); // Parse JSON request bodies
app.use(express.urlencoded({ extended: false })); // Parse URL-encoded request bodies
app.use(cookieParser()); // Parse cookies
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files
app.use(cors()); // Enable Cross-Origin Resource Sharing

// =======================
// 9. FILE UPLOAD CONFIGURATION
// =======================

// Ensure upload folder exists at startup
try {
  if (!fsSync.existsSync(UPLOAD_FOLDER)) {
    fsSync.mkdirSync(UPLOAD_FOLDER, { recursive: true });
    console.log(`Created upload folder: ${UPLOAD_FOLDER}`);
  }
} catch (error) {
  console.error('Failed to create upload folder:', error);
  process.exit(1); // Exit if we can't create essential folders
}

// Configure file storage
const storageConfig = multer.diskStorage({
  destination: (request, file, callback) => {
    callback(null, UPLOAD_FOLDER);
  },
  filename: (request, file, callback) => {
    // Create unique filename with timestamp
    const timestamp = Date.now();
    const uniqueFilename = `pdf_${timestamp}.pdf`;
    callback(null, uniqueFilename);
  }
});

// Validate uploaded files
const fileFilterConfig = (request, file, callback) => {
  const allowedMimeTypes = ['application/pdf'];
  
  if (allowedMimeTypes.includes(file.mimetype)) {
    callback(null, true);
  } else {
    const error = new Error('Only PDF files are allowed');
    error.status = 400;
    callback(error, false);
  }
};

// Create multer upload instance
const upload = multer({
  storage: storageConfig,
  fileFilter: fileFilterConfig,
  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

// =======================
// 10. ROUTES
// =======================
app.use('/', indexRouter);
app.use('/users', usersRouter);

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (request, response) => {
  response.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// PDF Processing API Endpoint
app.post(
  '/api/process-pdf',
  upload.single('pdf'), // Handle single PDF upload
  async (request, response) => {
    try {
      // Validate file was uploaded
      if (!request.file) {
        return response.status(400).json({
          success: false,
          error: 'No PDF file uploaded'
        });
      }
      
      // Extract parameters with defaults
      const rows = request.body.row || DEFAULT_ROWS.toString();
      const columns = request.body.column || DEFAULT_COLUMNS.toString();
      
      // Process the PDF
      await processPdfPipeline(request.file.path, rows, columns);
      
      // Check if final PDF was created
      try {
        await fs.access(FINAL_PDF_PATH);
      } catch (error) {
        return response.status(500).json({
          success: false,
          error: 'PDF processing completed but output file was not created'
        });
      }
      
      // Send the processed PDF to client
      response.setHeader('Content-Type', 'application/pdf');
      response.setHeader('Content-Disposition', 'attachment; filename="FinalOutput.pdf"');
      
      const readStream = fsSync.createReadStream(FINAL_PDF_PATH);
      readStream.pipe(response);
      
      // Clean up files after streaming is complete
      readStream.on('close', async () => {
        try {
          // Remove the uploaded PDF file
          await removeFile(request.file.path);
          console.log('Cleaned up uploaded PDF file');
          
          // Remove the final generated PDF file
          await removeFile(FINAL_PDF_PATH);
          console.log('Cleaned up final generated PDF file');
          
          // Optional: Also clean up any old files in uploads folder
          try {
            const files = await fs.readdir(UPLOAD_FOLDER);
            const currentTime = Date.now();
            const ONE_HOUR = 60 * 60 * 1000; // 1 hour in milliseconds
            
            for (const file of files) {
              const filePath = path.join(UPLOAD_FOLDER, file);
              const stats = await fs.stat(filePath);
              
              // Remove files older than 1 hour to prevent storage buildup
              if (currentTime - stats.mtimeMs > ONE_HOUR) {
                await removeFile(filePath);
                console.log(`Cleaned up old file: ${file}`);
              }
            }
          } catch (cleanupError) {
            console.warn('Failed to clean up old uploads:', cleanupError.message);
          }
          
        } catch (cleanupError) {
          console.warn('Failed to clean up files:', cleanupError.message);
        }
      });
      
      // Handle stream errors
      readStream.on('error', async (error) => {
        console.error('Stream error:', error);
        try {
          await removeFile(request.file.path);
          await removeFile(FINAL_PDF_PATH);
        } catch (cleanupError) {
          console.warn('Failed to clean up files after stream error:', cleanupError.message);
        }
      });
      
      // Handle response finish event
      response.on('finish', () => {
        console.log('Response sent successfully to client');
      });
      
    } catch (error) {
      console.error('API processing error:', error);
      
      // Clean up uploaded file on error
      if (request.file && request.file.path) {
        try {
          await removeFile(request.file.path);
        } catch (cleanupError) {
          console.warn('Failed to clean up uploaded file after error:', cleanupError.message);
        }
      }
      
      // Clean up final PDF if it exists
      try {
        await removeFile(FINAL_PDF_PATH);
      } catch (cleanupError) {
        // Ignore if file doesn't exist
      }
      
      response.status(500).json({
        success: false,
        error: error.message || 'PDF processing failed'
      });
    }
  }
);

// Add a cleanup route for manual cleanup if needed
app.post('/api/cleanup', async (request, response) => {
  try {
    let cleanedFiles = [];
    
    // Clean up final PDF if exists
    try {
      await fs.access(FINAL_PDF_PATH);
      await removeFile(FINAL_PDF_PATH);
      cleanedFiles.push('FinalOutput.pdf');
    } catch (error) {
      // File doesn't exist, ignore
    }
    
    // Clean up temporary folders
    await Promise.all([
      removeFolder(TEMP_UPLOAD_FOLDER),
      removeFolder(STAGE_1_FOLDER),
      removeFolder(STAGE_2_FOLDER),
      removeFolder(FINAL_FOLDER)
    ]);
    
    // Clean up old files in uploads folder
    try {
      const files = await fs.readdir(UPLOAD_FOLDER);
      for (const file of files) {
        const filePath = path.join(UPLOAD_FOLDER, file);
        await removeFile(filePath);
        cleanedFiles.push(file);
      }
    } catch (error) {
      // Ignore errors
    }
    
    response.json({
      success: true,
      message: 'Cleanup completed',
      cleanedFiles: cleanedFiles,
      count: cleanedFiles.length
    });
    
  } catch (error) {
    console.error('Cleanup error:', error);
    response.status(500).json({
      success: false,
      error: 'Cleanup failed'
    });
  }
});

// =======================
// 11. ERROR HANDLING
// =======================

// Handle 404 errors
app.use((request, response, next) => {
  next(createError(404));
});

// Global error handler
app.use((error, request, response, next) => {
  // Set default status code if not set
  const statusCode = error.status || 500;
  
  // Log error for debugging
  console.error('Application error:', {
    message: error.message,
    stack: error.stack,
    status: statusCode,
    path: request.path,
    method: request.method
  });
  
  // Send error response
  response.status(statusCode).json({
    success: false,
    error: error.message || 'An unexpected error occurred',
    // Only include stack trace in development
    ...(app.get('env') === 'development' && { stack: error.stack })
  });
});

// =======================
// 12. STARTUP CLEANUP
// =======================
async function startupCleanup() {
  console.log('Performing startup cleanup...');
  
  try {
    // Clean up final PDF from previous session
    await removeFile(FINAL_PDF_PATH);
    
    // Clean up temporary folders from previous session
    await Promise.all([
      removeFolder(TEMP_UPLOAD_FOLDER),
      removeFolder(STAGE_1_FOLDER),
      removeFolder(STAGE_2_FOLDER),
      removeFolder(FINAL_FOLDER)
    ]);
    
    console.log('Startup cleanup completed');
  } catch (error) {
    console.warn('Startup cleanup had some issues:', error.message);
  }
}

// Run startup cleanup when the server starts
startupCleanup().catch(console.error);

// =======================
// 13. EXPORT APPLICATION
// =======================
module.exports = app;
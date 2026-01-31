
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Minimal version of ocrWorker logic for direct use
export async function performOcrOnPdf(pdfPath: string): Promise<string> {
  const tmpDir = path.join('/tmp', `ocr-${Date.now()}-${Math.random().toString(36).substring(7)}`);
  
  try {
    await fs.mkdir(tmpDir, { recursive: true });
    
    // Convert to images
    const outPrefix = path.join(tmpDir, 'page');
    await execAsync(`pdftoppm -png "${pdfPath}" "${outPrefix}"`);
    
    const files = await fs.readdir(tmpDir);
    const imageFiles = files
      .filter(f => f.startsWith('page') && f.endsWith('.png'))
      .sort()
      .map(f => path.join(tmpDir, f));
    
    if (imageFiles.length === 0) throw new Error('No pages extracted from PDF');

    console.log(`[OCR Utils] Processing ${imageFiles.length} pages...`);
    const texts: string[] = [];
    
    // Process sequentially to be safe on memory
    for (const img of imageFiles) {
        const base = img.replace('.png', '');
        await execAsync(`tesseract "${img}" "${base}" -l eng --psm 3`);
        const text = await fs.readFile(`${base}.txt`, 'utf-8');
        texts.push(text);
    }
    
    return texts.join('\n\n--- Page Break ---\n\n');
    
  } finally {
    try {
      // Cleanup
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

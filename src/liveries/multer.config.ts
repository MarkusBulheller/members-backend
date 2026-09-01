import { UnsupportedMediaTypeException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { diskStorage } from 'multer';

export const LIVERIES_UPLOAD_DIR = join(process.cwd(), 'uploads', 'liveries');

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export const liveryMulterOptions: MulterOptions = {
  storage: diskStorage({
    destination: (_req, _file, callback) => {
      if (!existsSync(LIVERIES_UPLOAD_DIR)) {
        mkdirSync(LIVERIES_UPLOAD_DIR, { recursive: true });
      }
      callback(null, LIVERIES_UPLOAD_DIR);
    },
    filename: (_req, file, callback) => {
      callback(null, `${randomUUID()}${extname(file.originalname)}`);
    },
  }),
  fileFilter: (_req, file, callback: (error: Error | null, acceptFile: boolean) => void) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      callback(new UnsupportedMediaTypeException('Only PNG, JPEG, or WEBP images are allowed'), false);
      return;
    }
    callback(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 },
};

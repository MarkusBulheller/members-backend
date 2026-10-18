import { UnsupportedMediaTypeException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { diskStorage } from 'multer';

export const CARS_UPLOAD_DIR = join(process.cwd(), 'uploads', 'cars');
/** Public path prefix stored in Car.imageUrl for admin-uploaded images (iRacing stock images are
 * full CDN URLs instead, so this prefix is also how the service tells the two apart). */
export const CARS_UPLOAD_URL_PREFIX = '/uploads/cars/';

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// Same shape as liveries/multer.config.ts.
export const carImageMulterOptions: MulterOptions = {
  storage: diskStorage({
    destination: (_req, _file, callback) => {
      if (!existsSync(CARS_UPLOAD_DIR)) {
        mkdirSync(CARS_UPLOAD_DIR, { recursive: true });
      }
      callback(null, CARS_UPLOAD_DIR);
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

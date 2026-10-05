// Tests use a separate database + Redis DB index so they never touch dev data.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://wehum:wehum@localhost:5432/wehum_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
process.env.LOG_LEVEL = 'silent';
process.env.APPLE_BUNDLE_IDS = 'app.wehum.meditation';
process.env.GOOGLE_CLIENT_IDS = 'test-google-client';
process.env.TOTP_ENC_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
process.env.ADMIN_APP_URL = 'http://localhost:5173';
process.env.S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000';
process.env.S3_BUCKET = 'wehum-test';
process.env.S3_ACCESS_KEY = 'minio';
process.env.S3_SECRET_KEY = 'minio12345';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH ?? require('ffmpeg-static');
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH ?? require('@ffprobe-installer/ffprobe').path;

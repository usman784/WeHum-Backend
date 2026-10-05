// Tests use a separate database + Redis DB index so they never touch dev data.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://wehum:wehum@localhost:5432/wehum_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
process.env.LOG_LEVEL = 'silent';

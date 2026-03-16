process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';
process.env.GEMINI_API_KEY = 'test-api-key';
process.env.APP_API_KEY = 'test-app-key';
process.env.APP_API_URL = 'https://api.example.com';
// Generic org/secret env vars consumed by config.ts and middleware
process.env.DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000000';
process.env.INTERNAL_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.NODE_ENV = 'test';

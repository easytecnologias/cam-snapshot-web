import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4100),
  jwtSecret: process.env.JWT_SECRET || 'dev-change-me',
  databaseUrl: process.env.DATABASE_URL || '',
  urbackupBaseUrl: process.env.URBACKUP_BASE_URL || 'http://localhost:55414',
  corsOrigin: process.env.CORS_ORIGIN || '*',
};

/**
 * Environment variable validation
 * 
 * Validates required environment variables at startup and fails fast
 * if any are missing. This prevents silent failures later in the app.
 */

interface EnvConfig {
  // Required
  DATABASE_URL: string;
  JWT_SECRET: string;
  GEMINI_API_KEY: string;
  
  // Optional with defaults
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';
  
  // Optional features
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  OCR_ENABLED: boolean;
  OCR_PROVIDER: 'tesseract' | 'none';
  OCR_MIN_CHAR_THRESHOLD: number;
}

const REQUIRED_VARS = [
  'DATABASE_URL',
  'JWT_SECRET', 
  'GEMINI_API_KEY',
] as const;

const OPTIONAL_VARS_WITH_DEFAULTS: Record<string, string> = {
  PORT: '5000',
  NODE_ENV: 'development',
  OCR_ENABLED: 'true',
  OCR_PROVIDER: 'tesseract',
  OCR_MIN_CHAR_THRESHOLD: '1200',
};

/**
 * Validates that all required environment variables are set.
 * Call this at app startup before any other initialization.
 * 
 * @throws Error if any required variables are missing
 */
export function validateEnv(): void {
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const varName of REQUIRED_VARS) {
    const value = process.env[varName];
    if (!value || value.trim() === '') {
      missing.push(varName);
    }
  }

  // Check for weak JWT secret in production
  if (process.env.NODE_ENV === 'production') {
    const jwtSecret = process.env.JWT_SECRET || '';
    if (jwtSecret.length < 32) {
      warnings.push('JWT_SECRET should be at least 32 characters in production');
    }
  }

  // Check for admin credentials (warn if missing, don't fail)
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    warnings.push('ADMIN_EMAIL and ADMIN_PASSWORD not set - admin account will not be auto-created');
  }

  // Log warnings
  for (const warning of warnings) {
    console.warn(`⚠️  ENV WARNING: ${warning}`);
  }

  // Fail if required vars are missing
  if (missing.length > 0) {
    const message = `Missing required environment variables:\n${missing.map(v => `  - ${v}`).join('\n')}`;
    console.error(`\n❌ STARTUP FAILED\n${message}\n`);
    throw new Error(message);
  }

  console.log('✅ Environment variables validated');
}

/**
 * Get a validated environment configuration object.
 * Only call after validateEnv() has succeeded.
 */
export function getEnvConfig(): EnvConfig {
  return {
    DATABASE_URL: process.env.DATABASE_URL!,
    JWT_SECRET: process.env.JWT_SECRET!,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY!,
    PORT: parseInt(process.env.PORT || OPTIONAL_VARS_WITH_DEFAULTS.PORT, 10),
    NODE_ENV: (process.env.NODE_ENV || OPTIONAL_VARS_WITH_DEFAULTS.NODE_ENV) as EnvConfig['NODE_ENV'],
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    OCR_ENABLED: process.env.OCR_ENABLED !== 'false',
    OCR_PROVIDER: (process.env.OCR_PROVIDER || OPTIONAL_VARS_WITH_DEFAULTS.OCR_PROVIDER) as EnvConfig['OCR_PROVIDER'],
    OCR_MIN_CHAR_THRESHOLD: parseInt(process.env.OCR_MIN_CHAR_THRESHOLD || OPTIONAL_VARS_WITH_DEFAULTS.OCR_MIN_CHAR_THRESHOLD, 10),
  };
}

/**
 * Type-safe environment variable getter with default.
 * Use for optional variables that have sensible defaults.
 */
export function getEnvVar(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

/**
 * Type-safe required environment variable getter.
 * Throws if the variable is not set. Use after validateEnv().
 */
export function requireEnvVar(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

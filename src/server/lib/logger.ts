/**
 * Structured logging module for the budget server.
 *
 * - Production: JSON output for log aggregators
 * - Development: Human-readable colored output
 * - Test: Silent by default (LOG_LEVEL=debug to enable)
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  [key: string]: unknown;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: {
    message: string;
    stack?: string;
    name?: string;
  };
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};

const RESET = "\x1b[0m";

function getLogLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env && env in LOG_LEVELS) return env as LogLevel;
  // Default: silent in test, info otherwise
  if (process.env.NODE_ENV === "test") return "error";
  return "info";
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function shouldLog(level: LogLevel): boolean {
  const currentLevel = getLogLevel();
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatError(error: unknown): LogEntry["error"] | undefined {
  if (!error) return undefined;
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      name: error.name,
    };
  }
  return { message: String(error) };
}

function formatJson(entry: LogEntry): string {
  return JSON.stringify(entry);
}

function formatPretty(entry: LogEntry): string {
  const color = LEVEL_COLORS[entry.level];
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const levelStr = `${color}${entry.level.toUpperCase().padEnd(5)}${RESET}`;

  let output = `${time} ${levelStr} ${entry.message}`;

  if (entry.context && Object.keys(entry.context).length > 0) {
    output += ` ${JSON.stringify(entry.context)}`;
  }

  if (entry.error) {
    output += `\n  ${LEVEL_COLORS.error}Error: ${entry.error.message}${RESET}`;
    if (entry.error.stack && process.env.LOG_LEVEL === "debug") {
      output += `\n  ${entry.error.stack}`;
    }
  }

  return output;
}

function log(level: LogLevel, message: string, context?: LogContext, error?: unknown): void {
  if (!shouldLog(level)) return;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    context: context && Object.keys(context).length > 0 ? context : undefined,
    error: formatError(error),
  };

  const output = isProduction() ? formatJson(entry) : formatPretty(entry);

  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  debug: (message: string, context?: LogContext) => log("debug", message, context),
  info: (message: string, context?: LogContext) => log("info", message, context),
  warn: (message: string, context?: LogContext, error?: unknown) => log("warn", message, context, error),
  error: (message: string, context?: LogContext, error?: unknown) => log("error", message, context, error),
};

export default logger;

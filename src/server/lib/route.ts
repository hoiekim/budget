import { logger } from "server/lib/logger";
import { sendAlarm } from "server/lib/alarm";
import type { MaskedUser } from "./postgres/models/user";

export type Method = "GET" | "POST" | "DELETE";

export interface ApiResponse<T = undefined> {
  status: "loading" | "streaming" | "success" | "failed" | "error";
  body?: T;
  message?: string;
}

export type Stream<T = undefined> = (response: ApiResponse<T>) => void;

export interface ServerSession {
  user?: MaskedUser;
  id: string;
  regenerate(callback: (err?: Error) => void): void;
  destroy(callback?: (err?: Error) => void): void;
}

export interface ServerRequest {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  rawBody?: string;
  session: ServerSession;
  ip: string;
}

export interface ServerResponse {
  statusCode: number;
  headersSent: boolean;
  status(code: number): ServerResponse;
  write(data: string): boolean;
  end(): void;
}

export type GetResponse<T = undefined> = (
  req: ServerRequest,
  res: ServerResponse,
  stream: Stream<T>,
) => Promise<ApiResponse<T> | void>;

export class Route<T> {
  path: string;
  method: Method;
  callback: GetResponse<T>;

  constructor(method: Method, path: string, callback: GetResponse<T>) {
    this.path = path;
    this.method = method;
    this.callback = callback;
  }

  async execute(req: ServerRequest, res: ServerResponse): Promise<ApiResponse<T> | null> {
    try {
      const stream: Stream<T> = (response) => {
        res.write(JSON.stringify(response) + "\n");
      };
      const result = await this.callback(req, res, stream);
      return result ?? null;
    } catch (error: unknown) {
      logger.error("Route handler error", { method: this.method, path: this.path }, error);
      sendAlarm(
        `Route Error: ${this.method} ${this.path}`,
        `**Error:** ${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => undefined);
      res.status(500);
      return { status: "error", message: "Internal server error" };
    }
  }
}

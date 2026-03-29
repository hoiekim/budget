import { RequestHandler, Request, Response } from "express";
import { logger } from "server";
import { sendAlarm } from "server/lib/alarm";

export type Method = "GET" | "POST" | "DELETE";

export interface ApiResponse<T = undefined> {
  status: "loading" | "streaming" | "success" | "failed" | "error";
  body?: T;
  message?: string;
}

export type Stream<T = undefined> = (response: ApiResponse<T>) => void;

export type GetResponse<T = undefined> = (
  req: Request,
  res: Response,
  stream: Stream<T>
) => Promise<ApiResponse<T> | void>;

export class Route<T> {
  path: string;
  handler: RequestHandler;

  constructor(method: Method, path: string, callback: GetResponse<T>) {
    this.path = path;
    this.handler = async (req, res, next) => {
      if (req.method === method) {
        try {
          const stream: Stream<T> = (response) => {
            res.write(JSON.stringify(response) + "\n");
          };
          const result = await callback(req, res, stream);
          if (result) res.json(result);
          else res.end();
          return;
        } catch (error: unknown) {
          logger.error("Route handler error", { method, path }, error);
          // Always return a generic message in 500 responses — the full error is in server logs.
          // NODE_ENV is not reliably set at runtime (it's provided via docker run --env-file).
          const message = "Internal server error";
          sendAlarm(
            `Route Error: ${method} ${path}`,
            `**Error:** ${error instanceof Error ? error.message : String(error)}`
          ).catch(() => undefined);
          res.status(500).json({ status: "error", message });
        }
      }
      next();
    };
  }
}

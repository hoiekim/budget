import { RequestHandler, Request, Response } from "express";

export type Method = "GET" | "POST" | "DELETE";

export interface ApiResponse<T = undefined> {
  status: "loading" | "streaming" | "success" | "failed" | "error";
  body?: T;
  message?: string;
}

export type Stream<T = undefined> = (response: ApiResponse<T>) => void;

export type GetResponse<T = any> = (
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
        } catch (error: any) {
          console.error(error);
          res.status(500).json({ status: "error", info: error?.message });
        }
      }
      next();
    };
  }
}

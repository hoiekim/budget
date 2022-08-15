import { RequestHandler, Request, Response } from "express";

export type Method = "GET" | "POST" | "DELETE";

export interface ApiResponse<T = undefined> {
  status: "loading" | "streaming" | "success" | "failed" | "error";
  data?: T;
  info?: string;
}

export type GetResponse<T = any> = (
  req: Request,
  res: Response
) => Promise<ApiResponse<T> | void>;

export class Route<T> {
  path: string;
  handler: RequestHandler;

  constructor(method: Method, path: string, callback: GetResponse<T>) {
    this.path = path;
    this.handler = async (req, res, next) => {
      if (req.method === method) {
        try {
          const result = await callback(req, res);
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

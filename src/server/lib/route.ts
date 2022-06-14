import { RequestHandler, Request, Response } from "express";

export interface ApiResponse<T = undefined> {
  status: "loading" | "streaming" | "success" | "failed" | "error";
  data?: T;
  info?: string;
}

export type GetResponse<T = any> = (
  req: Request,
  res: Response
) => Promise<ApiResponse<T> | void>;

export class Route {
  path: string;
  handler: RequestHandler;

  constructor(
    method: "GET" | "POST" | "DELETE",
    path: string,
    callback: GetResponse
  ) {
    this.path = path;
    this.handler = async (req, res, next) => {
      if (req.method === method) {
        try {
          const result = await callback(req, res);
          if (result) res.json(result);
          else res.end();
        } catch (error: any) {
          console.error(error);
          res.status(500).json({ status: "error", info: error.message });
        }
        return;
      }
      next();
    };
  }
}

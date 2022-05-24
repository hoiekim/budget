import { RequestHandler, Request, Response } from "express";

export interface ApiResponse {
  status: "success" | "error";
  data?: any;
  info?: string;
}

export type HandlerCallback = (
  req: Request,
  res: Response
) => Promise<ApiResponse>;

export class Handler {
  handler: RequestHandler;
  constructor(method: "GET" | "POST" | "DELETE", callback: HandlerCallback) {
    this.handler = async (req, res) => {
      if (req.method !== method) return;
      let status = 200;
      const result = await callback(req, res);
      if (result.status === "error") status = 500;
      res.status(status).json(result);
    };
  }
}

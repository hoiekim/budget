import { MaskedUser } from "./lib";

declare module "express-session" {
  export interface SessionData {
    user: MaskedUser;
  }
}

export * from "./lib";
export * from "./routes";

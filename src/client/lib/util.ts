import { AccountType } from "plaid";
import { Account as _Account, DeepPartial } from "server";

export const numberToCommaString = (n: number, fixed = 2) => {
  const sign = n < 0 ? "-" : "";

  const splitNumberString = Math.abs(n).toFixed(fixed).toString().split(".");
  const firstPart = splitNumberString[0];
  const secondPart = splitNumberString[1];

  const { length } = firstPart;
  let integer = "";
  let i = 0;
  let skip = length % 3;
  while (i < length) {
    if (i && !((i - skip) % 3)) integer += ",";
    integer += firstPart[i];
    i++;
  }

  const fraction = secondPart ? "." + secondPart : "";

  return sign + integer + fraction;
};

export const currencyCodeToSymbol = (code: string) => {
  switch (code) {
    case "USD":
      return "$";
    default:
      return code;
  }
};

export const getRandomId = () =>
  (65536 + Math.floor(Math.random() * 983040)).toString(16);

export interface Account extends _Account {}

export class Account implements Account {
  constructor(account?: DeepPartial<Account>) {
    this.item_id = getRandomId();
    this.institution_id = getRandomId();
    this.account_id = getRandomId();
    this.custom_name = "";
    this.hide = false;
    this.balances = {
      available: 0,
      current: 0,
      limit: 0,
      iso_currency_code: "USD",
      unofficial_currency_code: "USD",
    };
    this.label = {};
    this.mask = "0000";
    this.name = "Unknown";
    this.official_name = "Unknown";
    this.type = AccountType.Other;
    this.subtype = null;
    Object.assign(this, account);
  }
}

export const isEmoji = (s: string) => /\p{Extended_Pictographic}/u.test(s);

export const MAX_FLOAT = 3.402823567e38;

export type Timeout = ReturnType<typeof setTimeout>;

export const clamp = (n: number, min: number, max: number) => {
  return Math.min(Math.max(n, min), max);
};

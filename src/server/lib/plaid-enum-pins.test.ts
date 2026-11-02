/**
 * Pins the local Plaid enum tables against the installed SDK's runtime
 * values (review finding on #1028): a hand-edit — or a regeneration
 * against a mismatched SDK install — that moves a value must fail here,
 * not silently change which accounts match. The tables are also asserted
 * frozen, so a runtime write over a member throws instead of corrupting
 * every later comparison in the process.
 *
 * The generator's header claims a moved value "shows up as a type error
 * or a failing test" — this is the test that makes that claim true.
 */
import { describe, expect, test } from "bun:test";
import {
  AccountType as SdkAccountType,
  AccountSubtype as SdkAccountSubtype,
  AccountBaseVerificationStatusEnum as SdkAccountBaseVerificationStatusEnum,
  CountryCode as SdkCountryCode,
  Products as SdkProducts,
  TransactionCode as SdkTransactionCode,
  TransactionPaymentChannelEnum as SdkTransactionPaymentChannelEnum,
  TransactionTransactionTypeEnum as SdkTransactionTransactionTypeEnum,
  InvestmentTransactionType as SdkInvestmentTransactionType,
  InvestmentTransactionSubtype as SdkInvestmentTransactionSubtype,
} from "plaid";
import {
  AccountType,
  AccountSubtype,
  AccountBaseVerificationStatusEnum,
  CountryCode,
  Products,
  TransactionCode,
  TransactionPaymentChannelEnum,
  TransactionTransactionTypeEnum,
  InvestmentTransactionType,
  InvestmentTransactionSubtype,
} from "common/lib/plaid-enums";

const TABLES: [string, Record<string, string>, Record<string, string>][] = [
  ["AccountType", AccountType, SdkAccountType],
  ["AccountSubtype", AccountSubtype, SdkAccountSubtype],
  [
    "AccountBaseVerificationStatusEnum",
    AccountBaseVerificationStatusEnum,
    SdkAccountBaseVerificationStatusEnum,
  ],
  ["CountryCode", CountryCode, SdkCountryCode],
  ["Products", Products, SdkProducts],
  ["TransactionCode", TransactionCode, SdkTransactionCode],
  [
    "TransactionPaymentChannelEnum",
    TransactionPaymentChannelEnum,
    SdkTransactionPaymentChannelEnum,
  ],
  [
    "TransactionTransactionTypeEnum",
    TransactionTransactionTypeEnum,
    SdkTransactionTransactionTypeEnum,
  ],
  ["InvestmentTransactionType", InvestmentTransactionType, SdkInvestmentTransactionType],
  [
    "InvestmentTransactionSubtype",
    InvestmentTransactionSubtype,
    SdkInvestmentTransactionSubtype,
  ],
];

describe("local Plaid enum tables", () => {
  for (const [name, local, sdk] of TABLES) {
    test(`${name} matches the installed SDK member-for-member`, () => {
      expect(Object.isFrozen(local)).toBe(true);
      expect(Object.keys(local).sort()).toEqual(Object.keys(sdk).sort());
      for (const key of Object.keys(local)) {
        expect(local[key]).toBe(sdk[key]);
      }
    });
  }
});

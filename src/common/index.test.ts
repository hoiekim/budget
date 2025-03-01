import { isEqual } from "./utils";
import { Account, Institution, Item } from "./models";

test("isEqual should return true when the two input accounts have the same property values", () => {
  const commonInstitution = new Institution();
  const commonItem = new Item();

  const accountA = new Account({
    account_id: "1a2b3c",
    id: "1",
    name: "a",
    institution_id: commonInstitution.id,
    item_id: commonItem.id,
  });

  const accountB = new Account({
    account_id: "1a2b3c",
    id: "1",
    name: "a",
    institution_id: commonInstitution.id,
    item_id: commonItem.id,
  });

  expect(isEqual(accountA, accountB)).toBe(true);

  const accountC = new Account(accountA);
  expect(isEqual(accountA, accountC)).toBe(true);
  expect(isEqual(accountB, accountC)).toBe(true);
});

test("isEqual should return false when the two input accounts have different property values", () => {
  const accountD = new Account();
  const accountE = new Account();
  expect(isEqual(accountD, accountE)).toBe(false);
});

test("Account model should create a copy when initializing with another Account object", () => {
  const accountF = new Account();
  const accountG = new Account(accountF);
  expect(accountF === accountG).toBe(false);
  expect(isEqual(accountF, accountG)).toBe(true);
});

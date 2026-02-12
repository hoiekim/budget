import { test, expect } from "bun:test";
import { getHitScore } from "./search";

test("getHitScore should ignore cases", () => {
  expect(getHitScore("Banana", "Banana")).toBe(1);
  expect(getHitScore("Banana", "banana")).toBe(1);
  expect(getHitScore("Banana", "BaNaNa")).toBe(1);
  expect(getHitScore("banana", "Banana")).toBe(1);
  expect(getHitScore("BaNANa", "Banana")).toBe(1);
});

test("getHitScore should return reasonable scores", () => {
  expect(getHitScore("Apple", "Apple")).toBe(1);
  expect(getHitScore("Apple", "Appple")).toBeCloseTo(0.83);
  expect(getHitScore("Apple", "An Apple")).toBeCloseTo(0.8);
  expect(getHitScore("Apple", "An Apple Juice")).toBeCloseTo(0.73);
  expect(getHitScore("Apple", "App")).toBeCloseTo(0.6);
  expect(getHitScore("Apple", "Pineapple")).toBeCloseTo(0.56);
  expect(getHitScore("Apple", "Ap ple")).toBeCloseTo(0.55);
  expect(getHitScore("Apple", "Nice App")).toBeCloseTo(0.5);
  expect(getHitScore("Apple", "Very Nice App")).toBeCloseTo(0.43);
  expect(getHitScore("Apple", "A")).toBeCloseTo(0.2);
  expect(getHitScore("Apple", "I love lemon")).toBeCloseTo(0.13);
  expect(getHitScore("Apple", "I go to gym")).toBe(0);
});

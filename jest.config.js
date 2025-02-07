/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  moduleDirectories: ["node_modules", "src"],
  testEnvironment: "node",
  transform: {
    "^.+.tsx?$": ["ts-jest", {}],
  },
};

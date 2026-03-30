// Preload script to set up browser environment for tests
// This runs before any test file imports
Object.assign(globalThis, { window: {} });

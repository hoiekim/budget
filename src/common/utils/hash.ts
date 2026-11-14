const PASSES: [number, number][] = [
  [0x811c9dc5, 0x01000193],
  [0x6c62272e, 0x5bd1e995],
  [0x07bb0142, 0x85ebca6b],
  [0x9e3779b9, 0xc2b2ae35],
];

/**
 * A deterministic 128-bit hash as 32 hex digits, identical in the browser and
 * on the server: four FNV-1a-style passes, each with its own offset basis and
 * odd multiplier. Enough to tell apart the rows of one account, not a
 * cryptographic digest.
 */
export const hash128 = (text: string): string =>
  PASSES.map(([basis, multiplier]) => {
    let h = basis;
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), multiplier);
    }
    h ^= h >>> 16;
    return (h >>> 0).toString(16).padStart(8, "0");
  }).join("");

export const getHitScore = (searchWord: string, document: string) => {
  if (!searchWord || !document) return 0;

  const words = document.toLowerCase().split(/\W+/);
  const search = searchWord.toLowerCase();

  let total = 0;
  let max = 0;

  words.forEach((word) => {
    const distance = levenshteinDistance(search, word);
    const maxLength = Math.max(search.length, word.length);
    const score = 1 - distance / maxLength;
    total += score;
    max = Math.max(max, score);
  });

  const average = total / words.length;

  return (max + average) / 2;
};

const levenshteinDistance = (a: string, b: string) => {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));

  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
      }
    }
  }

  return dp[a.length][b.length];
};

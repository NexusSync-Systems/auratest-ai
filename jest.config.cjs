module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.jsx?$': 'babel-jest',
  },
  // `frontend/` má vlastní běhový nástroj (vitest) a testy používají jeho API
  // (`vi`, `import.meta`). Bez tohohle je kořenový jest sbírá taky a padá na
  // nich — výchozí testMatch hledá *.test.* kdekoli v projektu.
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/e2e/',
    '/generated-scripts/',
    '<rootDir>/frontend/',
  ],
};

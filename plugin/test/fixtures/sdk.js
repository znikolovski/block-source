// Stand-in for https://da.live/nx/utils/sdk.js; the test sets globalThis.daSdk first.
export default Promise.resolve(globalThis.daSdk);

/**
 * True in the single executable built for GitHub releases (`define` in tsdown.config.ts), which
 * may replace itself; undefined in every other build and under tsx. Read it through `SELF_UPDATE`.
 */
declare const __DIFFLE_SELF_UPDATE__: boolean | undefined;

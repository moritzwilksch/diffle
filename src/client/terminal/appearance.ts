import type { ITheme } from 'ghostty-web';
import symbolsUrl from './SymbolsNerdFontMono-Regular.woff2?url';

const symbols = 'Diffle Terminal Symbols';
// Canvas needs concrete family names. The bundled symbol face comes before system fallbacks.
export const terminalFont = `"JetBrains Mono Variable", "${symbols}", "SF Mono", Menlo, Consolas, monospace`;

let fonts: Promise<void> | undefined;

export function loadTerminalFonts(): Promise<void> {
  return (fonts ??= Promise.all([
    document.fonts.load('14px "JetBrains Mono Variable"', 'MW0'),
    new FontFace(symbols, `url("${symbolsUrl}")`).load().then((face) => document.fonts.add(face)),
  ])
    .then(() => undefined)
    .catch((error: unknown) => {
      fonts = undefined;
      throw error;
    }));
}

const darkPalette: ITheme = {
  background: '#10141b',
  foreground: '#e7edf4',
  cursor: '#8dc2ff',
  cursorAccent: '#10141b',
  selectionBackground: '#29496a',
  black: '#232b36',
  red: '#ff7b82',
  green: '#72d99e',
  yellow: '#edca7a',
  blue: '#8dc2ff',
  magenta: '#d4a8ff',
  cyan: '#76d9df',
  white: '#e7edf4',
  brightBlack: '#8995a5',
  brightRed: '#ffa3a8',
  brightGreen: '#98eab5',
  brightYellow: '#ffdf99',
  brightBlue: '#aecfff',
  brightMagenta: '#e4c6ff',
  brightCyan: '#9aeaf0',
  brightWhite: '#f8fafc',
};

const lightPalette: ITheme = {
  background: '#f8faff',
  foreground: '#202a37',
  cursor: '#174da6',
  cursorAccent: '#f8faff',
  selectionBackground: '#cbdffd',
  black: '#202a37',
  red: '#ad243b',
  green: '#206539',
  yellow: '#845601',
  blue: '#245cb5',
  magenta: '#704395',
  cyan: '#006577',
  white: '#526172',
  brightBlack: '#626e7c',
  brightRed: '#a31b32',
  brightGreen: '#28724a',
  brightYellow: '#8a5700',
  brightBlue: '#195caa',
  brightMagenta: '#85419c',
  brightCyan: '#026778',
  brightWhite: '#485569',
};

export function terminalPalette(): ITheme {
  const choice = document.documentElement.dataset.theme;
  const dark = choice ? choice === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  return dark ? darkPalette : lightPalette;
}

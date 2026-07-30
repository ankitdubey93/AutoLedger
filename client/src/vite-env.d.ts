/// <reference types="vite/client" />

/**
 * Typing the env surface turns a missing variable into a compile error rather
 * than `undefined` reaching a fetch URL as the string "undefined".
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

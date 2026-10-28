/** Files the build embeds in the server as bytes (tsup.config.ts). */
declare module '*.ttf' {
  const data: Uint8Array;
  export default data;
}

declare module '*.wasm' {
  const data: Uint8Array;
  export default data;
}

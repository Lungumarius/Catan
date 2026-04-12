/// <reference types="vite/client" />

declare module '*.mp3' {
  const src: string;
  export default src;
}

declare module '*.mp3?url' {
  const src: string;
  export default src;
}

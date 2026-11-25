/** 打包时注入的构建编号（tsdown define）。 */
declare const __BUILD__: string

declare module '*.svg' {
  const url: string
  export default url
}
declare module '*.webp' {
  const url: string
  export default url
}

// Fixture imports in browser tests are bundled as strings by scripts/browser-ci.mjs
// (esbuild loaders: .html/.txt/.xml -> text, .json -> json).
declare module '*.html' {
  const text: string
  export default text
}
declare module '*.txt' {
  const text: string
  export default text
}
declare module '*.xml' {
  const text: string
  export default text
}

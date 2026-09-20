/** Minimal type declarations for mammoth's browser build (no bundled subpath types). */
declare module 'mammoth/mammoth.browser.js' {
  interface ConvertResult {
    readonly value: string
    readonly messages: readonly { readonly type: string; readonly message: string }[]
  }

  interface ArrayInput {
    readonly arrayBuffer: ArrayBuffer
  }

  const mammoth: {
    convertToHtml(input: ArrayInput): Promise<ConvertResult>
  }

  export default mammoth
}

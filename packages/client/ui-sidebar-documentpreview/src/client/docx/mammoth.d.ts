/** Minimal type declarations for mammoth (no official @types package). */
declare module 'mammoth' {
  interface ConvertResult {
    readonly value: string
    readonly messages: readonly { readonly type: string; readonly message: string }[]
  }

  interface ArrayInput {
    readonly arrayBuffer: ArrayBuffer
  }

  function convertToHtml(input: ArrayInput): Promise<ConvertResult>
}

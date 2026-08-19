export {}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: Record<string, unknown>
    }
  }
}

declare namespace React {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: Record<string, unknown>
    }
  }
}

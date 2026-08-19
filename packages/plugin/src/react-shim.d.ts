declare module 'react' {
  export function useEffect(effect: () => void | (() => void), deps?: unknown[]): void
  export function useMemo<T>(factory: () => T, deps?: unknown[]): T
  export function useState<T>(initial: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void]
  export const Fragment: unique symbol
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: Record<string, unknown>
    }
  }
}
declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: Record<string, unknown>
    }
  }
}
declare module 'react/jsx-runtime' {
  export function jsx(type: unknown, props: unknown, key?: unknown): unknown
  export function jsxs(type: unknown, props: unknown, key?: unknown): unknown
}

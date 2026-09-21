export function stampPreview(phase: string): void {
  const w = window as Window & { __vulcainTypst?: Record<string, number> }
  w.__vulcainTypst = { ...w.__vulcainTypst, [phase]: performance.now() }
}

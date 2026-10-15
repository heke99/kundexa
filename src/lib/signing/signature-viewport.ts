/** Preserve every stroke when the CSS drawing surface changes size. */
export function rescaleSignatureGroups<T extends { points: Array<{ x: number; y: number }> }>(groups: T[], scaleX: number, scaleY: number): T[] {
  return groups.map(group => ({ ...group, points: group.points.map(point => ({ ...point, x: point.x * scaleX, y: point.y * scaleY })) }));
}

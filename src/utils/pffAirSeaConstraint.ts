/**
 * Air/sea zones are one-directional (departure → arrival); land zones are
 * bidirectional. Route enumeration enforces this, so a flight/voyage only ever
 * appears on the route whose direction matches. The payment route
 * (receiver → sender) and goods route (sender → receiver) may each use air/sea
 * legs independently when a route runs in their direction.
 */

export function isAirOrSeaTransportMode(mode: string | null | undefined): boolean {
  return mode === "air" || mode === "sea";
}

export function zoneIdsUseAirOrSea(
  zoneIds: number[],
  zoneMeta: Map<number, { transport_mode: string | null }>,
): boolean {
  return zoneIds.some((id) =>
    isAirOrSeaTransportMode(zoneMeta.get(id)?.transport_mode ?? null),
  );
}

export function segmentsUseAirOrSea(
  segments: Array<{ transport_method: string }>,
): boolean {
  return segments.some((s) => isAirOrSeaTransportMode(s.transport_method));
}

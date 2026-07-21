import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankPreviewChains, type OrderDraftChain } from "./orderZoneConnection.service";

function makeZone(
  id: number,
  transportMode: "land" | "air" | "sea",
  baseFee: number
): any {
  return {
    id,
    zone_name: `Zone ${id}`,
    owner_user_id: id,
    transport_name: `Transport ${id}`,
    transport_mode: transportMode,
    resolution: 8,
    cell_count: 1,
    departure_hub: transportMode === "air" || transportMode === "sea" ? { name: "A", lat: 0, lng: 0 } : null,
    arrival_hub: transportMode === "air" || transportMode === "sea" ? { name: "B", lat: 0, lng: 0 } : null,
    departure_time: null,
    arrival_time: null,
    operation_date: null,
    operation_start_date: null,
    operation_end_date: null,
    schedule_pattern: "daily",
    weekday_start: null,
    weekday_end: null,
    month_day_start: null,
    month_day_end: null,
    operating_start_time: null,
    operating_end_time: null,
    base_fee: baseFee,
    cost_per_km: 0,
    cost_per_hour: 0,
    currency: "USD",
    trust_payment_forwarder: false,
    driver_trustworthiness: 0,
  };
}

describe("rankPreviewChains", () => {
  const endpoints = {
    source: { lat: 0, lng: 0 },
    destination: { lat: 0, lng: 0 },
  };

  it("sorts by cheapest, then fewer hops, then air priority", () => {
    const zoneById = new Map<number, any>([
      [1, makeZone(1, "land", 10)],
      [2, makeZone(2, "air", 10)],
      [3, makeZone(3, "land", 10)],
      [4, makeZone(4, "air", 20)],
    ]);
    const centroids = new Map<number, { lat: number; lng: number }>([
      [1, { lat: 0, lng: 0 }],
      [2, { lat: 0, lng: 0 }],
      [3, { lat: 0, lng: 0 }],
      [4, { lat: 0, lng: 0 }],
    ]);
    const connections = new Map<number, any>();
    const chains: OrderDraftChain[] = [
      { zone_ids: [1], connection_ids: [], hops: 3 },
      { zone_ids: [2], connection_ids: [], hops: 1 },
      { zone_ids: [3], connection_ids: [], hops: 1 },
      { zone_ids: [4], connection_ids: [], hops: 0 },
    ];

    const ranked = rankPreviewChains(chains, zoneById, connections, centroids, endpoints);

    assert.deepEqual(
      ranked.map((chain) => chain.zone_ids[0]),
      [2, 3, 1, 4]
    );
  });

  it("returns only the 25 cheapest routes", () => {
    const zoneById = new Map<number, any>();
    const centroids = new Map<number, { lat: number; lng: number }>();
    const connections = new Map<number, any>();
    const chains: OrderDraftChain[] = [];

    for (let i = 1; i <= 30; i++) {
      zoneById.set(i, makeZone(i, "land", i));
      centroids.set(i, { lat: 0, lng: 0 });
      chains.push({ zone_ids: [i], connection_ids: [], hops: i });
    }

    const ranked = rankPreviewChains(chains, zoneById, connections, centroids, endpoints);

    assert.equal(ranked.length, 25);
    assert.deepEqual(
      ranked.map((chain) => chain.zone_ids[0]),
      Array.from({ length: 25 }, (_, idx) => idx + 1)
    );
  });
});

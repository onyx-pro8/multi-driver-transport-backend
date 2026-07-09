import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { segmentNeedsCostEntry, segmentNeedsRecalculation } from "../models/routeCost.model";
import {
  calculatePackageFactor,
  calculateTotalCost,
  calculateTravelCost,
  calculateWaitingCost,
  deriveSegmentsFromRoute,
  estimateLandTransitHours,
  resolveSegmentTimeHours,
  scheduleDurationHours,
  transportRequiresCostRequest,
} from "./costCalculation.service";

describe("calculatePackageFactor", () => {
  it("maps package types to client factors", () => {
    assert.equal(calculatePackageFactor("letter", null), 0.01);
    assert.equal(calculatePackageFactor("large", null), 0.2);
    assert.equal(calculatePackageFactor(null, null), 0.05);
  });

  it("sums factors for multiple packages", () => {
    assert.equal(
      calculatePackageFactor(null, null, [
        {
          package_type: "small",
          weight_lbs: 5,
          package_length: 10,
          package_width: 8,
          package_height: 6,
        },
        {
          package_type: "medium",
          weight_lbs: 12,
          package_length: 20,
          package_width: 15,
          package_height: 10,
        },
      ]),
      0.07
    );
  });

  it("prefers explicit factor when set", () => {
    assert.equal(calculatePackageFactor("small", 0.15), 0.15);
  });
});

describe("scheduleDurationHours", () => {
  it("computes hours between HH:MM times", () => {
    assert.equal(scheduleDurationHours("09:00", "11:30"), 2.5);
  });

  it("handles overnight wrap", () => {
    assert.equal(scheduleDurationHours("22:00", "02:00"), 4);
  });
});

describe("resolveSegmentTimeHours", () => {
  it("falls back to land distance estimate when no schedule", () => {
    const hours = resolveSegmentTimeHours("land", null, null, 100);
    assert.equal(hours, 2);
  });

  it("falls back to sea distance estimate when no schedule", () => {
    const hours = resolveSegmentTimeHours("sea", null, null, 370);
    assert.equal(hours, 10);
  });
});

describe("estimateLandTransitHours", () => {
  it("uses default land speed", () => {
    assert.equal(estimateLandTransitHours(50), 1);
  });
  it("accepts configurable land speed", () => {
    assert.equal(estimateLandTransitHours(100, 25), 4);
  });
});

describe("cost components", () => {
  it("calculates travel and waiting", () => {
    assert.equal(calculateTravelCost(10, 2), 20);
    assert.equal(calculateWaitingCost(3, 25), 75);
  });

  it("applies booking fee to sub-total", () => {
    const { subTotal, bookingFee, total } = calculateTotalCost(10, 20, 5, 0.02);
    assert.equal(subTotal, 35);
    assert.equal(bookingFee, 0.7);
    assert.equal(total, 35.7);
  });
});

describe("segment status helpers", () => {
  it("treats requested as needing entry but not recalculation", () => {
    assert.equal(segmentNeedsCostEntry("requested"), true);
    assert.equal(segmentNeedsRecalculation("requested"), false);
    assert.equal(segmentNeedsRecalculation("missing"), true);
  });
});

describe("deriveSegmentsFromRoute", () => {
  it("builds sender-to-receiver segments for standard orders", () => {
    const zoneMeta = new Map([
      [10, { owner_user_id: 1, transport_mode: "land" }],
      [20, { owner_user_id: 2, transport_mode: "land" }],
    ]);
    const segments = deriveSegmentsFromRoute([10, 20], zoneMeta, "standard");
    assert.equal(segments.length, 2);
    assert.equal(segments[0].from_node_id, "sender");
    assert.equal(segments[0].to_node_id, "10");
    assert.equal(segments[1].to_node_id, "receiver");
    assert.equal(segments[0].leg_phase, null);
  });

  it("builds payment route segments receiver→sender for PFF payment routes", () => {
    const zoneMeta = new Map([
      [10, { owner_user_id: 1, transport_mode: "land" }],
      [20, { owner_user_id: 2, transport_mode: "land" }],
    ]);
    const segments = deriveSegmentsFromRoute([10, 20], zoneMeta, "payment");
    assert.equal(segments.length, 2);
    assert.equal(segments[0].leg_phase, "payment");
    assert.equal(segments[0].from_node_id, "receiver");
    assert.equal(segments[0].to_node_id, "10");
    assert.equal(segments[1].to_node_id, "sender");
    assert.equal(segments[1].handoff_role, "payment_delivery");
  });

  it("builds goods route segments sender→receiver for PFF goods routes", () => {
    const zoneMeta = new Map([
      [10, { owner_user_id: 1, transport_mode: "land" }],
      [20, { owner_user_id: 2, transport_mode: "land" }],
    ]);
    const segments = deriveSegmentsFromRoute([10, 20], zoneMeta, "goods");
    assert.equal(segments.length, 2);
    assert.equal(segments[0].leg_phase, "goods");
    assert.equal(segments[0].from_node_id, "sender");
    assert.equal(segments[0].to_node_id, "10");
    assert.equal(segments[0].handoff_role, "goods_pickup");
    assert.equal(segments[1].to_node_id, "receiver");
  });
});

describe("transport rules", () => {
  it("requires cost request for air only", () => {
    assert.equal(transportRequiresCostRequest("air"), true);
    assert.equal(transportRequiresCostRequest("sea"), false);
    assert.equal(transportRequiresCostRequest("land"), false);
  });
});

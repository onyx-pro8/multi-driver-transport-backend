import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveTrackingStatusFromLegs,
  phaseLegDelivered,
} from "./segment_tracking.service";

describe("phaseLegDelivered", () => {
  it("treats picked_up + in_transit chain as complete when last segment is in transit", () => {
    assert.equal(phaseLegDelivered(["picked_up", "in_transit", "in_transit"]), true);
    assert.equal(phaseLegDelivered(["picked_up", "picked_up", "in_transit"]), true);
  });

  it("requires the final segment to be in transit", () => {
    assert.equal(phaseLegDelivered(["picked_up", "picked_up", "picked_up"]), false);
    assert.equal(phaseLegDelivered(["in_transit"]), true);
  });
});

describe("deriveTrackingStatusFromLegs (PFF)", () => {
  it("returns PAYMENT_DELIVERED when payment leg reaches producer", () => {
    const status = deriveTrackingStatusFromLegs([], true, {
      isPff: true,
      paymentLegCount: 3,
      goodsReady: false,
      allSegments: [
        { segment_index: 0, leg_status: "picked_up", leg_phase: "payment" },
        { segment_index: 1, leg_status: "in_transit", leg_phase: "payment" },
        { segment_index: 2, leg_status: "in_transit", leg_phase: "payment" },
        { segment_index: 3, leg_status: "not_started", leg_phase: "goods" },
      ],
    });
    assert.equal(status, "PAYMENT_DELIVERED");
  });
});

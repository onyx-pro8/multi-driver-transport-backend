import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** Mirrors routeCost.service quote grouping helpers. */
function quoteLegPhaseKey(legPhase: unknown): string {
  const phase = legPhase != null ? String(legPhase) : null;
  if (phase === "payment" || phase === "goods") return phase;
  return "standard";
}

function quoteDedupKey(
  orderId: number,
  transporterId: number,
  pricedZoneId: number,
  legPhase: unknown,
): string {
  return `${orderId}:${transporterId}:${pricedZoneId}:${quoteLegPhaseKey(legPhase)}`;
}

describe("quote segment grouping", () => {
  it("keeps payment and goods legs separate on the same priced zone", () => {
    const paymentKey = quoteDedupKey(32, 5, 101, "payment");
    const goodsKey = quoteDedupKey(32, 5, 101, "goods");
    assert.notEqual(paymentKey, goodsKey);
  });

  it("groups standard-order legs without leg_phase", () => {
    const a = quoteDedupKey(10, 3, 50, null);
    const b = quoteDedupKey(10, 3, 50, undefined);
    assert.equal(a, b);
    assert.equal(a, "10:3:50:standard");
  });

  it("groups multiple goods route candidates on the same leg", () => {
    const route6 = quoteDedupKey(32, 5, 101, "goods");
    const route23 = quoteDedupKey(32, 5, 101, "goods");
    assert.equal(route6, route23);
  });
});

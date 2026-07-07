import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  segmentsUseAirOrSea,
  zoneIdsUseAirOrSea,
} from "./pffAirSeaConstraint";

describe("pffAirSeaConstraint", () => {
  it("detects air/sea zones in a chain", () => {
    const meta = new Map([
      [1, { transport_mode: "land" }],
      [2, { transport_mode: "air" }],
    ]);
    assert.equal(zoneIdsUseAirOrSea([1], meta), false);
    assert.equal(zoneIdsUseAirOrSea([1, 2], meta), true);
  });

  it("detects air/sea segments", () => {
    assert.equal(
      segmentsUseAirOrSea([{ transport_method: "land" }]),
      false,
    );
    assert.equal(
      segmentsUseAirOrSea([{ transport_method: "land" }, { transport_method: "sea" }]),
      true,
    );
  });
});

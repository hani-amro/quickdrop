import { describe, expect, it } from "vitest";
import { coordPair, loadOsrmConfig, parseRoute, parseTable, routeUrl, tableUrl } from "./osrm.js";

const damascus = { lat: 33.5138, lng: 36.2765 };
const homs = { lat: 34.7324, lng: 36.7137 };

describe("loadOsrmConfig", () => {
  it("null when OSRM_URL unset (→ haversine fallback)", () => {
    expect(loadOsrmConfig({})).toBeNull();
    expect(loadOsrmConfig({ OSRM_URL: "  " })).toBeNull();
  });
  it("trims trailing slashes", () => {
    expect(loadOsrmConfig({ OSRM_URL: "http://osrm:5000/" })).toEqual({ base: "http://osrm:5000" });
  });
});

describe("coordPair — ترتيب OSRM lng,lat (D7)", () => {
  it("emits lng first, lat second (NOT lat,lng)", () => {
    expect(coordPair(damascus)).toBe("36.2765,33.5138");
  });
});

describe("routeUrl / tableUrl", () => {
  it("route url uses lng,lat;lng,lat and overview=false", () => {
    expect(routeUrl("http://o:5000", damascus, homs)).toBe(
      "http://o:5000/route/v1/driving/36.2765,33.5138;36.7137,34.7324?overview=false&alternatives=false",
    );
  });
  it("table url puts sources first, dest last, with index params", () => {
    const url = tableUrl("http://o:5000", [damascus, homs], { lat: 33.5, lng: 36.3 });
    expect(url).toContain("/table/v1/driving/36.2765,33.5138;36.7137,34.7324;36.3,33.5");
    expect(url).toContain("sources=0;1");
    expect(url).toContain("destinations=2");
    expect(url).toContain("annotations=distance");
  });
});

describe("parseRoute", () => {
  it("extracts rounded distance/duration on code Ok", () => {
    expect(parseRoute({ code: "Ok", routes: [{ distance: 2815.6, duration: 405.2 }] })).toEqual({
      distanceM: 2816,
      durationS: 405,
    });
  });
  it("null on non-Ok, empty, or malformed", () => {
    expect(parseRoute({ code: "NoRoute", routes: [] })).toBeNull();
    expect(parseRoute({ code: "Ok", routes: [] })).toBeNull();
    expect(parseRoute({ code: "Ok", routes: [{ distance: "x", duration: 1 }] })).toBeNull();
    expect(parseRoute(null)).toBeNull();
    expect(parseRoute("nope")).toBeNull();
  });
});

describe("parseTable", () => {
  it("extracts the single destination column per source", () => {
    expect(parseTable({ code: "Ok", distances: [[1200], [3400]] })).toEqual([1200, 3400]);
  });
  it("null on malformed rows", () => {
    expect(parseTable({ code: "Ok", distances: [[]] })).toBeNull();
    expect(parseTable({ code: "Ok", distances: "x" })).toBeNull();
    expect(parseTable({ code: "Err" })).toBeNull();
  });
});

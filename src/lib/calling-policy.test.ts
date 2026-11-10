import { describe, expect, it } from "vitest";
import { type CallingScope, dealerNumberRefusal, NUMBER_NOT_ALLOWED, numberAllowed } from "./calling-policy";

const MINE = "+919000012345";
const OTHER = "+919876543210";
const TESTING: CallingScope = { mode: "testing", allowedNumbers: [MINE] };
const PRODUCTION: CallingScope = { mode: "production", allowedNumbers: [] };

describe("numberAllowed", () => {
  it("in testing, allows only the listed numbers", () => {
    expect(numberAllowed(MINE, TESTING)).toBe(true);
    expect(numberAllowed(OTHER, TESTING)).toBe(false);
  });

  it("in production, allows any number", () => {
    expect(numberAllowed(OTHER, PRODUCTION)).toBe(true);
  });
});

describe("dealerNumberRefusal", () => {
  it("in testing, refuses a new dealer on another number, and says how to switch", () => {
    expect(dealerNumberRefusal(MINE, null, TESTING)).toBeNull();
    expect(dealerNumberRefusal(OTHER, null, TESTING)).toBe(NUMBER_NOT_ALLOWED);
    expect(NUMBER_NOT_ALLOWED).toContain("ALLOWED_NUMBERS");
    expect(NUMBER_NOT_ALLOWED).toContain("NABZ_MODE=production");
    expect(NUMBER_NOT_ALLOWED).toContain("NABZ_MODE=production");
  });

  it("in testing, refuses changing a dealer to another number", () => {
    expect(dealerNumberRefusal(OTHER, MINE, TESTING)).toBe(NUMBER_NOT_ALLOWED);
  });

  it("in testing, lets a dealer keep the number they already have", () => {
    expect(dealerNumberRefusal(OTHER, OTHER, TESTING)).toBeNull();
  });

  it("in production, allows any number", () => {
    expect(dealerNumberRefusal(OTHER, null, PRODUCTION)).toBeNull();
  });
});

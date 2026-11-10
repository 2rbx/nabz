import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const base = {
  DATABASE_URL: "postgres://nabz:pw@127.0.0.1:5432/nabz_dev",
};

describe("parseEnv", () => {
  it("defaults to the safe mode", () => {
    expect(parseEnv(base).NABZ_MODE).toBe("testing");
  });

  it("treats empty values as unset", () => {
    expect(parseEnv({ ...base, NABZ_MODE: "" }).NABZ_MODE).toBe("testing");
  });

  it("requires a postgres URL", () => {
    expect(() => parseEnv({ ...base, DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
  });
});

describe("NABZ_MODE and ALLOWED_NUMBERS", () => {
  it("defaults to testing, with nobody allowed", () => {
    expect(parseEnv(base)).toMatchObject({ NABZ_MODE: "testing", ALLOWED_NUMBERS: [] });
  });

  it("reads the mode and normalises the numbers", () => {
    expect(
      parseEnv({ ...base, NABZ_MODE: "production", ALLOWED_NUMBERS: "9000012345, +91 90000 54321" }),
    ).toMatchObject({ NABZ_MODE: "production", ALLOWED_NUMBERS: ["+919000012345", "+919000054321"] });
  });

  it("refuses to start on an unknown mode or a bad number", () => {
    expect(() => parseEnv({ ...base, NABZ_MODE: "staging" })).toThrow(/NABZ_MODE/);
    expect(() => parseEnv({ ...base, ALLOWED_NUMBERS: "9000012345,nope" })).toThrow(/ALLOWED_NUMBERS/);
  });

});

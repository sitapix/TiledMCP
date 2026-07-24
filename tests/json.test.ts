import { describe, expect, it } from "vitest";

import { parseJsonDocument } from "../src/formats/json.js";

describe("parseJsonDocument safety", () => {
  it.each([
    '{"duplicate":1,"duplicate":2}',
    '{"name":1,"\\u006eame":2}',
  ])("rejects duplicate object keys: %s", (source) => {
    expect(() => parseJsonDocument(source, "map.tmj")).toThrow(
      expect.objectContaining({ code: "DUPLICATE_JSON_KEY" }),
    );
  });

  it.each([
    '{"value":1e400}',
    '{"value":9007199254740992}',
    '{"value":-9007199254740992}',
  ])("rejects numbers that JSON.parse cannot preserve safely: %s", (source) => {
    expect(() => parseJsonDocument(source, "map.tmj")).toThrow(
      expect.objectContaining({ code: "UNSAFE_JSON_NUMBER" }),
    );
  });

  it("rejects excessively deep JSON before recursive domain traversal", () => {
    const source = `${"[".repeat(514)}0${"]".repeat(514)}`;
    expect(() => parseJsonDocument(source, "map.tmj")).toThrow(
      expect.objectContaining({ code: "JSON_NESTING_LIMIT" }),
    );
  });

  it("accepts normal Tiled-compatible JSON numbers and escaped keys", () => {
    expect(
      parseJsonDocument(
        '{"\\u0074ype":"map","integer":9007199254740991,"float":1.25e-3}',
        "map.tmj",
      ),
    ).toEqual({
      type: "map",
      integer: 9007199254740991,
      float: 0.00125,
    });
  });
});

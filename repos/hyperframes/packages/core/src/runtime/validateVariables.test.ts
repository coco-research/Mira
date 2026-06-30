import { describe, it, expect } from "vitest";
import { validateVariables, formatVariableValidationIssue } from "./validateVariables";
import type { CompositionVariable } from "../core.types";

const DECLS: readonly CompositionVariable[] = [
  { id: "title", type: "string", label: "Title", default: "Hello" },
  { id: "count", type: "number", label: "Count", default: 0 },
  { id: "active", type: "boolean", label: "Active", default: true },
  { id: "color", type: "color", label: "Color", default: "#000000" },
  {
    id: "theme",
    type: "enum",
    label: "Theme",
    default: "light",
    options: [
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
  },
];

describe("validateVariables", () => {
  it("returns no issues when every value matches its declaration", () => {
    expect(
      validateVariables(
        { title: "Q4", count: 3, active: false, color: "#abcdef", theme: "dark" },
        DECLS,
      ),
    ).toEqual([]);
  });

  it("returns no issues for an empty values map", () => {
    expect(validateVariables({}, DECLS)).toEqual([]);
  });

  it("flags undeclared keys", () => {
    expect(validateVariables({ title: "x", extra: 1 }, DECLS)).toEqual([
      { kind: "undeclared", variableId: "extra" },
    ]);
  });

  it("flags string vs number mismatches", () => {
    expect(validateVariables({ count: "three" }, DECLS)).toEqual([
      { kind: "type-mismatch", variableId: "count", expected: "number", actual: "string" },
    ]);
  });

  it("flags non-finite numbers as type mismatches", () => {
    expect(validateVariables({ count: Number.NaN }, DECLS)).toEqual([
      { kind: "type-mismatch", variableId: "count", expected: "number", actual: "number" },
    ]);
  });

  it("flags boolean mismatches", () => {
    expect(validateVariables({ active: "true" }, DECLS)).toEqual([
      { kind: "type-mismatch", variableId: "active", expected: "boolean", actual: "string" },
    ]);
  });

  it("flags non-string color values", () => {
    expect(validateVariables({ color: 0xff0000 }, DECLS)).toEqual([
      { kind: "type-mismatch", variableId: "color", expected: "color", actual: "number" },
    ]);
  });

  it("flags enum values not in the allowed set", () => {
    expect(validateVariables({ theme: "midnight" }, DECLS)).toEqual([
      {
        kind: "enum-out-of-range",
        variableId: "theme",
        allowed: ["light", "dark"],
        actual: "midnight",
      },
    ]);
  });

  it("flags non-string enum values as type mismatches", () => {
    expect(validateVariables({ theme: 1 }, DECLS)).toEqual([
      { kind: "type-mismatch", variableId: "theme", expected: "enum (string)", actual: "number" },
    ]);
  });

  it("returns multiple issues at once", () => {
    const issues = validateVariables({ title: 42, theme: "neon", extra: true }, DECLS);
    expect(issues).toContainEqual({
      kind: "type-mismatch",
      variableId: "title",
      expected: "string",
      actual: "number",
    });
    expect(issues).toContainEqual({
      kind: "enum-out-of-range",
      variableId: "theme",
      allowed: ["light", "dark"],
      actual: "neon",
    });
    expect(issues).toContainEqual({ kind: "undeclared", variableId: "extra" });
  });
});

describe("formatVariableValidationIssue", () => {
  it("formats undeclared issues", () => {
    expect(formatVariableValidationIssue({ kind: "undeclared", variableId: "extra" })).toBe(
      'Variable "extra" is not declared in data-composition-variables.',
    );
  });

  it("formats type-mismatch issues", () => {
    expect(
      formatVariableValidationIssue({
        kind: "type-mismatch",
        variableId: "count",
        expected: "number",
        actual: "string",
      }),
    ).toBe('Variable "count" expected number, got string.');
  });

  it("formats enum-out-of-range issues", () => {
    expect(
      formatVariableValidationIssue({
        kind: "enum-out-of-range",
        variableId: "theme",
        allowed: ["light", "dark"],
        actual: "neon",
      }),
    ).toBe('Variable "theme" must be one of "light", "dark" (got "neon").');
  });
});

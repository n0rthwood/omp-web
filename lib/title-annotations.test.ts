import { describe, expect, test } from "bun:test";
import { parseTitleAnnotations } from "./title-annotations";

describe("parseTitleAnnotations", () => {
  test("no leading (...) prefix returns the title unchanged with no annotations", () => {
    const result = parseTitleAnnotations("修复登录问题");
    expect(result.annotations).toBeNull();
    expect(result.text).toBe("修复登录问题");
  });

  test("a single main issue prefix is parsed and stripped", () => {
    const result = parseTitleAnnotations("(#12) 修复登录问题");
    expect(result.annotations).toEqual({ main: [12], related: [] });
    expect(result.text).toBe("修复登录问题");
  });

  test("multiple main issues joined by ' · ' are all parsed", () => {
    const result = parseTitleAnnotations("(#12 · #13) 修复登录问题");
    expect(result.annotations).toEqual({ main: [12, 13], related: [] });
    expect(result.text).toBe("修复登录问题");
  });

  test("related-only issues are parsed", () => {
    const result = parseTitleAnnotations("(rel #10, #7) 修复登录问题");
    expect(result.annotations).toEqual({ main: [], related: [10, 7] });
    expect(result.text).toBe("修复登录问题");
  });

  test("main and related issues together are parsed", () => {
    const result = parseTitleAnnotations("(#12 · rel #10, #7) 修复登录问题");
    expect(result.annotations).toEqual({ main: [12], related: [10, 7] });
    expect(result.text).toBe("修复登录问题");
  });

  test("a parenthesized issue reference mid-string or at the end is not mistaken for a prefix", () => {
    const midString = parseTitleAnnotations("修复登录问题 (#12) 相关的 bug");
    expect(midString.annotations).toBeNull();
    expect(midString.text).toBe("修复登录问题 (#12) 相关的 bug");

    const trailing = parseTitleAnnotations("修复登录问题 (#12)");
    expect(trailing.annotations).toBeNull();
    expect(trailing.text).toBe("修复登录问题 (#12)");
  });

  test("parenthesized content that isn't #-number syntax is left as plain text", () => {
    const result = parseTitleAnnotations("(备注) 标题");
    expect(result.annotations).toBeNull();
    expect(result.text).toBe("(备注) 标题");
  });
});

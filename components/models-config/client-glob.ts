/**
 * Glob → RegExp for code that runs in the browser (#154).
 *
 * omp matches the `enabledModels` syntax with `Bun.Glob` on the server, but
 * the `Bun` global does not exist in a browser bundle: referencing it there
 * throws and unmounts the whole app. This covers the subset that syntax uses:
 *
 * - `*` stays inside one path segment, `?` is one non-`/` character;
 * - a whole-segment `**` crosses `/` (followed by a slash it may also match
 *   zero segments); `**` fused to other text is a plain `*`;
 * - `{a,b}` alternates and may nest, `[5-9]` / `[!x]` are character classes;
 * - `\x` escapes one character; anything else is literal.
 *
 * `client-glob.test.mjs` pins this against `Bun.Glob` itself, so a pattern pasted
 * from `enabledModels` into the overview filter selects what the server does.
 */

const escapeLiteral = (text: string) => text.replace(/[$()*+.?[\\\]^{|}/]/g, "\\$&");

/** `[...]` starting at `start`; the class source and the index of its `]`, or undefined when unclosed. */
function readClass(pattern: string, start: number): { source: string; end: number } | undefined {
  let index = start + 1;
  let negate = false;
  if (pattern[index] === "!" || pattern[index] === "^") {
    negate = true;
    index += 1;
  }
  let body = "";
  let first = true;
  for (; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "]" && !first) return { source: `[${negate ? "^" : ""}${body}]`, end: index };
    first = false;
    if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      body += `\\${pattern[index]}`;
    } else if (char === "-" || char === "]") {
      body += char === "]" ? "\\]" : "-";
    } else {
      body += escapeLiteral(char);
    }
  }
  return undefined;
}

/** Index of the `}` closing the `{` at `start`, honouring nested braces and escapes. */
function findBraceEnd(pattern: string, start: number): number {
  let depth = 0;
  for (let index = start; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") index += 1;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

/** Split `text` on top-level commas (commas inside nested braces stay put). */
function splitAlternatives(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(from, index));
      from = index + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

function toSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      source += escapeLiteral(pattern[index]);
    } else if (char === "*") {
      const wholeSegment = pattern[index + 1] === "*"
        && (index === 0 || pattern[index - 1] === "/")
        && (index + 2 >= pattern.length || pattern[index + 2] === "/");
      if (wholeSegment) {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        // `**` fused to other text (`**free*`) is just `*`: Bun.Glob only treats
        // it as a globstar when it is a whole path segment.
        while (pattern[index + 1] === "*") index += 1;
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const cls = readClass(pattern, index);
      if (cls) {
        source += cls.source;
        index = cls.end;
      } else {
        source += escapeLiteral(char);
      }
    } else if (char === "{") {
      const end = findBraceEnd(pattern, index);
      if (end === -1) {
        source += escapeLiteral(char);
      } else {
        source += `(?:${splitAlternatives(pattern.slice(index + 1, end)).map(toSource).join("|")})`;
        index = end;
      }
    } else {
      source += escapeLiteral(char);
    }
  }
  return source;
}

export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${toSource(pattern)}$`);
}

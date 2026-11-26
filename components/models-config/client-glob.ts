/**
 * Glob → RegExp for code that runs in the browser (#154).
 *
 * omp matches the `enabledModels` syntax with `Bun.Glob` on the server, but
 * the `Bun` global does not exist in a browser bundle: referencing it there
 * throws and unmounts the whole app. This is the subset the allow-list
 * documents — `*` stays inside one path segment, `**` crosses `/`, `{a,b}`
 * alternates — and everything else is matched literally.
 */

export function globToRegExp(pattern: string): RegExp {
  const literal = (text: string) => text.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "{" && pattern.indexOf("}", index + 1) !== -1) {
      const end = pattern.indexOf("}", index + 1);
      source += `(?:${pattern.slice(index + 1, end).split(",").map(literal).join("|")})`;
      index = end;
    } else {
      source += literal(char);
    }
  }
  return new RegExp(`^${source}$`);
}

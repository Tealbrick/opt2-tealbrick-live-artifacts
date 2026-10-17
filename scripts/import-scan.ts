// Import specifiers of an emitted ES module, found by TOKENIZING the code (comments skipped; string, template and
// regex literals read as whole tokens), never by substring search: the words "import"/"export" inside a string
// (e.g. a "Backups & export" label) or a comment are not statements.

type Tok = { k: "id" | "str" | "punct"; v: string };

function tokenize(code: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = code.length;
  const regexAllowed = () => {
    const prev = out[out.length - 1];
    if (!prev) return true;
    if (prev.k === "str") return false;
    if (prev.k === "id") return /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(prev.v);
    return !/^[)\]}]$/.test(prev.v);
  };
  const readQuoted = (q: string): string => {
    let s = "";
    i++;
    while (i < n && code[i] !== q) {
      if (code[i] === "\\") {
        s += code[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (code[i] === "\n" && q !== "`") break;
      s += code[i];
      i++;
    }
    i++;
    return s;
  };
  const skipTemplate = () => {
    i++;
    let depth = 0;
    while (i < n) {
      const c = code[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (depth === 0 && c === "`") {
        i++;
        return;
      }
      if (c === "$" && code[i + 1] === "{") {
        depth++;
        i += 2;
        continue;
      }
      if (depth > 0 && c === "}") depth--;
      else if (depth > 0 && (c === '"' || c === "'")) {
        readQuoted(c);
        continue;
      }
      i++;
    }
  };
  while (i < n) {
    const c = code[i] as string;
    if (c === "/" && code[i + 1] === "/") {
      while (i < n && code[i] !== "\n") i++;
    } else if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      out.push({ k: "str", v: readQuoted(c) });
    } else if (c === "`") {
      skipTemplate();
      out.push({ k: "str", v: "" });
    } else if (c === "/" && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < n && code[i] !== "\n") {
        const r = code[i];
        if (r === "\\") i++;
        else if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(code[i] as string)) i++;
      out.push({ k: "str", v: "" });
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(code[j] as string)) j++;
      out.push({ k: "id", v: code.slice(i, j) });
      i = j;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      out.push({ k: "punct", v: c });
      i++;
    }
  }
  return out;
}

/** Static (`import "x"`, `import … from "x"`, `export … from "x"`) and dynamic (`import("x")`) specifiers. */
export function importSpecifiers(code: string): string[] {
  const toks = tokenize(code);
  const found = new Set<string>();
  for (let t = 0; t < toks.length; t++) {
    const tok = toks[t] as Tok;
    const prev = toks[t - 1];
    if (tok.k !== "id" || (prev?.k === "punct" && prev.v === ".")) continue;
    if (tok.v === "import") {
      const next = toks[t + 1];
      if (next?.k === "str") found.add(next.v);
      else if (next?.k === "punct" && next.v === "(" && toks[t + 2]?.k === "str" && toks[t + 3]?.v === ")") found.add((toks[t + 2] as Tok).v);
      else if (next && !(next.k === "punct" && (next.v === "(" || next.v === "."))) {
        for (let u = t + 1; u < toks.length && u < t + 400 && toks[u]?.v !== ";"; u++) {
          if (toks[u]?.k === "id" && (toks[u]?.v === "import" || toks[u]?.v === "export")) break;
          if (toks[u]?.k === "id" && toks[u]?.v === "from" && toks[u + 1]?.k === "str") {
            found.add((toks[u + 1] as Tok).v);
            break;
          }
        }
      }
    } else if (tok.v === "export") {
      const next = toks[t + 1];
      // re-exports only: `export { … } from "x"` and `export * [as ns] from "x"`
      if (next?.k === "punct" && (next.v === "{" || next.v === "*")) {
        for (let u = t + 1; u < toks.length && u < t + 400; u++) {
          const x = toks[u] as Tok;
          if (x.k === "punct" && x.v === ";") break;
          if (x.k === "id" && x.v === "from" && toks[u + 1]?.k === "str") {
            found.add((toks[u + 1] as Tok).v);
            break;
          }
        }
      }
    }
  }
  return [...found];
}

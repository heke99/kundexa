// Finds page reads that neither check `error` nor go through `ok()`.
//
// PostgREST does not throw: a failed read arrives as `{ data: null, error }`, so
// a page that destructures only `data` renders a broken query and an empty table
// identically. Used by the regression suite; see src/lib/supabase/read.ts.
//
// Shared scanning primitives. Comments matter: a `//` line inside a Promise.all
// containing a comma made the element count disagree with the binding count, so
// two of the largest pages were reported "cannot verify" and silently skipped.
const OPEN = { "(": ")", "[": "]", "{": "}" };
const CLOSE = { ")": "(", "]": "[", "}": "{" };

/** advance past a string, template, or comment starting at i; otherwise return i */
export function skipInert(src, i) {
  const ch = src[i];
  if (ch === '"' || ch === "'" || ch === "`") {
    const quote = ch;
    i += 1;
    while (i < src.length) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === quote) return i;
      i += 1;
    }
    return i;
  }
  if (ch === "/" && src[i + 1] === "/") {
    while (i < src.length && src[i] !== "\n") i += 1;
    return i - 1;
  }
  if (ch === "/" && src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2);
    return end === -1 ? src.length : end + 1;
  }
  return i;
}

export function matchBracket(src, start) {
  const stack = [src[start]];
  let i = start + 1;
  while (i < src.length && stack.length) {
    const next = skipInert(src, i);
    if (next !== i) { i = next + 1; continue; }
    const ch = src[i];
    if (OPEN[ch]) stack.push(ch);
    else if (CLOSE[ch]) { if (stack[stack.length - 1] !== CLOSE[ch]) return -1; stack.pop(); }
    i += 1;
  }
  return stack.length ? -1 : i - 1;
}

/** depth-0 comma split, returning [start, end] offsets into `src` */
export function splitTopLevel(src) {
  const parts = [];
  let depth = 0, start = 0, i = 0;
  while (i < src.length) {
    const next = skipInert(src, i);
    if (next !== i) { i = next + 1; continue; }
    const ch = src[i];
    if (OPEN[ch]) depth += 1;
    else if (CLOSE[ch]) depth -= 1;
    else if (ch === "," && depth === 0) { parts.push([start, i]); start = i + 1; }
    i += 1;
  }
  if (src.slice(start).trim()) parts.push([start, src.length]);
  return parts;
}

/**
 * Every local name bound to a Supabase client in this file. `/app/pipeline`
 * calls it `s`, which a hard-coded `supabase|admin` pattern missed entirely —
 * in both the fix and the check that was supposed to prove the fix.
 */
export function clientNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?create(?:Admin)?Client\s*\(/g)) names.add(m[1]);
  for (const m of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?createClient\s*\(/g)) names.add(m[1]);
  return names;
}

export const startsWithRead = (text, names) => {
  const m = /^([A-Za-z_$][\w$]*)\s*[.\n]/.exec(text.trim());
  return Boolean(m && names.has(m[1]));
};

/** unguarded reads in one file: neither `error` bound on the left nor ok() on the right */
export function unguardedReads(source, label) {
  const names = clientNames(source);
  if (!names.size) return [];
  const alternation = [...names].join("|");
  const found = [];
  const lineAt = (index) => source.slice(0, index).split("\n").length;

  const lhs = new RegExp("(?:const|let)\\s*\\[", "g");
  let hit;
  while ((hit = lhs.exec(source))) {
    const lhsOpen = source.indexOf("[", hit.index);
    const lhsClose = matchBracket(source, lhsOpen);
    if (lhsClose < 0) continue;
    const promiseAll = /^\s*=\s*await\s+Promise\.all\(\s*\[/.exec(source.slice(lhsClose + 1));
    if (!promiseAll) continue;
    const rhsOpen = lhsClose + 1 + promiseAll[0].lastIndexOf("[");
    const rhsClose = matchBracket(source, rhsOpen);
    if (rhsClose < 0) continue;
    const lhsInner = source.slice(lhsOpen + 1, lhsClose);
    const rhsInner = source.slice(rhsOpen + 1, rhsClose);
    const bindings = splitTopLevel(lhsInner).map(([a, b]) => lhsInner.slice(a, b));
    const elements = splitTopLevel(rhsInner).map(([a, b]) => rhsInner.slice(a, b));
    if (bindings.length !== elements.length) {
      found.push(`${label}:${lineAt(hit.index)} Promise.all: ${bindings.length} bindings vs ${elements.length} elements — unverifiable, split it up`);
      continue;
    }
    elements.forEach((element, index) => {
      const binding = bindings[index] ?? "";
      if (!binding.trim().startsWith("{")) return;
      if (/\berror\b/.test(binding)) return;
      if (!startsWithRead(element, names)) return;
      found.push(`${label}:${lineAt(rhsOpen)} Promise.all element ${index + 1}: ${element.trim().slice(0, 56)}…`);
    });
  }

  const simple = new RegExp(`(?:const|let)\\s*\\{([^}]{0,300}?)\\}\\s*=\\s*await\\s+(${alternation})(?=\\s*[.\\n])`, "g");
  while ((hit = simple.exec(source))) {
    if (/\berror\b/.test(hit[1])) continue;
    found.push(`${label}:${lineAt(hit.index)} ${hit[0].trim().replace(/\s+/g, " ").slice(0, 70)}…`);
  }
  return found;
}

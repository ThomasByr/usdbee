const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export const patchUsdLayerForThree = (layerPath: string, bytes: Uint8Array) => {
  if (bytes.length >= 8) {
    const header = String.fromCharCode(...bytes.subarray(0, 8));
    if (header === "PXR-USDC") return bytes;
  }

  // Small binary check
  const headerLen = Math.min(bytes.length, 50);
  const headerText = textDecoder.decode(bytes.subarray(0, headerLen));
  if (!headerText.includes("#usda")) {
    return bytes;
  }

  let asText = textDecoder.decode(bytes);

  if (asText.charCodeAt(0) === 0xfeff) asText = asText.slice(1);
  asText = asText.replace(/\r\n/g, "\n");

  if (!asText.startsWith("#usda")) return bytes;

  let patched = asText;

  // BUGFIX: Three.js USDAParser ignores `class` and `over`. Convert them to `def`.
  patched = patched.replace(/^[ \t]*class\s+/gm, "def ");
  patched = patched.replace(/^[ \t]*over\s+/gm, "def ");

  // BUGFIX: Three.js fails to pop the `meta` stack if `)` and `{` are on the same line.
  patched = patched.replace(/\)[ \t]*\{/g, ")\n{");

  // BUGFIX: Three.js fails to push/pop the `meta` stack correctly if `(` and `)` are on a single line.
  patched = patched.replace(
    /^[ \t]*(def|over|class)\s+([^(\n]+?)\s*\(\s*([^)\n]*)\s*\)/gm,
    (m, kw, name, inner) => {
      if (inner.includes("(")) return m; // skip if there are nested parentheses
      if (!inner.trim()) return `${kw} ${name} (\n)\n`;
      return `${kw} ${name} (\n${inner}\n)\n`;
    },
  );

  patched = patched.replace(/\b(add|append)\s+references\s*=/g, "prepend references =");

  patched = patched.replace(
    /(def\s+(?:[A-Za-z0-9_]+\s+)?"[^"]+"\s*\([^)]*?\b(?:prepend\s+)?references\s*=\s*)\[([^\]]+)\]([^)]*\))(\s*\{)?/g,
    (match: string, prefix: string, arrayInner: string, suffix: string, optBrace: string) => {
      const refs = Array.from(arrayInner.matchAll(/@([^@]+)@(?:<([^>]+)>)?/g)).map((m: any) => m[0]);
      if (refs.length <= 1) return match;

      let newHeader = `${prefix}${refs[0]}${suffix}\n`;
      let children = refs
        .slice(1)
        .map(
          (ref: string, idx: number) =>
            `    def Xform "usdbee_ref_${idx}" (\n        prepend references = ${ref}\n    )\n    {\n    }\n`,
        )
        .join("\n");

      if (optBrace) {
        return newHeader + optBrace + "\n" + children;
      } else {
        return newHeader + "{\n" + children + "\n}\n";
      }
    },
  );

  patched = patched.replace(/\b(add\s+|prepend\s+)?payload\s*=/g, "prepend references =");

  const defaultVariants = new Set<string>();
  const variantBindings = Array.from(patched.matchAll(/variants\s*=\s*\{([^}]+)\}/g));
  for (const match of variantBindings) {
    const inner = match[1];
    const bindMatches = Array.from(inner.matchAll(/string\s+\w+\s*=\s*"([^"]+)"/g));
    for (const bm of bindMatches) {
      defaultVariants.add(bm[1]);
    }
  }

  patched = patched.replace(/\bvariantSet\s+"([^"]+)"\s*=\s*\{/g, 'def Xform "variantSet_$1" {');

  patched = patched.replace(
    /^[ \t]*"([A-Za-z0-9_]+)"[ \t]*(?=[({])/gm,
    (match: string, variantName: string) => {
      // Keep if explicitly marked as default, or if we have no defaults at all (fallback to show something)
      if (defaultVariants.size === 0 || defaultVariants.has(variantName)) {
        return match.replace(`"${variantName}"`, `def Xform "usdbee_v_${variantName}"`);
      }
      return match.replace(`"${variantName}"`, `over "usdbee_v_${variantName}"`);
    },
  );

  // BUGFIX: Three.js ignores subLayers. Append them as dummy references at the end of the file.
  if (/\bsubLayers\s*=\s*\[/.test(patched)) {
    const subLayerBlocks = Array.from(patched.matchAll(/subLayers\s*=\s*\[([^\]]+)\]/g));
    let injections = "\n\n";
    let subLayerIdx = 0;

    for (const block of subLayerBlocks) {
      const refs = Array.from(block[1].matchAll(/@([^@]+)@/g)).map((m) => m[1]);
      for (const ref of refs) {
        injections += `def Xform "usdbee_sublayer_${subLayerIdx++}" (\n    prepend references = @${ref}@\n)\n{\n}\n`;
      }
    }

    if (subLayerIdx > 0) {
      patched += injections;
    }
  }

  return patched !== asText ? textEncoder.encode(patched) : bytes;
};

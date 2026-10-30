// Golden tests: pin the CURRENT behavior of the regex patches in usdUtils.ts.
// If a test fails, the test is wrong, not the code.
import { describe, expect, it } from "vitest";
import { patchUsdLayerForThree } from "./usdUtils";

const enc = new TextEncoder();
const dec = new TextDecoder();

const patch = (usda: string) => dec.decode(patchUsdLayerForThree("test.usda", enc.encode(usda)));

const passthrough = (usda: string) => expect(patch(usda)).toBe(usda);

describe("crate binary passthrough", () => {
  it("returns PXR-USDC bytes untouched", () => {
    const bytes = enc.encode("PXR-USDC____binary____");
    expect(patchUsdLayerForThree("test.usdc", bytes)).toBe(bytes);
  });

  it("returns non-usda bytes untouched", () => {
    const bytes = enc.encode("<html>whatever</html>");
    expect(patchUsdLayerForThree("test.whatever", bytes)).toBe(bytes);
  });
});

describe("class/over → def", () => {
  it("converts class and over prims to def", () => {
    const out = patch(`#usda 1.0

class _Geo "ClassyPrim"
{
}

over "SomePrim"
{
}

def Xform "Keep"
{
}
`);
    expect(out).toContain('def _Geo "ClassyPrim"');
    expect(out).toContain('def "SomePrim"');
  });

  it("strips leading indentation when converting", () => {
    const out = patch(`#usda 1.0

    over "Indented"
    {
    }
`);
    expect(out).toContain('def "Indented"');
  });

  it("leaves class/over inside a quoted name alone", () => {
    passthrough(`#usda 1.0

def Xform "myClassLoader"
{
    string class = "none"
}
`);
  });
});

describe("meta stack: `) {` on one line", () => {
  // realistic case: a stray `) {` after an attribute; a def-header paren would
  // also trigger the multi-line expansion patch and mask this rewrite
  it("puts { on its own line after )", () => {
    const out = patch(`#usda 1.0

def Cube "A"
{
    double foo = (1) {
}
`);
    expect(out).toContain(")\n{");
  });
});

describe("meta stack: `( ... )` macro args on one line", () => {
  it("expands single-line prim metadata parens to multiple lines", () => {
    const out = patch(`#usda 1.0

def Cube "A" (kind = "model")
{
}
`);
    expect(out).toContain('def Cube "A" (\nkind = "model"\n)');
  });

  it("skips nested parentheses", () => {
    passthrough(`#usda 1.0

def Cube "A" (customData = (1))
{
}
`);
  });
});

describe("add/append references = → prepend references =", () => {
  it("rewrites add and append references", () => {
    const out = patch(`#usda 1.0

def Cube "A" (
    add references = @a.usda@
)
{
}

def Cube "B" (
    append references = @b.usda@
)
{
}
`);
    expect(out).toContain("prepend references = @a.usda@");
    expect(out).toContain("prepend references = @b.usda@");
    expect(out).not.toContain("add references");
    expect(out).not.toContain("append references");
  });

  // content-level assertion: a prim-header paren block also triggers the
  // multi-line expansion patch, so full passthrough never applies here
  it("leaves plain references without add/append keyword alone", () => {
    const out = patch(`#usda 1.0

def Cube "A" (
    references = @a.usda@
)
{
}
`);
    expect(out).toContain("references = @a.usda@");
    expect(out).not.toContain("prepend references");
  });
});

describe("multi-reference list expansion", () => {
  it("splits multi-reference prim into first ref plus child Xforms", () => {
    const input = `#usda 1.0

def Cube "Merged" (
    references = [ @a.usda@, @b.usda@, @c.usda@ ]
)
{
}
`;
    const out = patch(input);
    expect(out).toContain("references = @a.usda@");
    // children are numbered from 0: ref_0 gets the second ref, ref_1 the third
    expect(out).toContain('def Xform "usdbee_ref_0" (');
    expect(out).toContain("prepend references = @b.usda@");
    expect(out).toContain('def Xform "usdbee_ref_1" (');
    expect(out).toContain("prepend references = @c.usda@");
    // the original def body keeps opening for the first ref
    expect(out).toContain('def Cube "Merged" (');
  });

  it("keeps single-reference lists unexpanded", () => {
    const out = patch(`#usda 1.0

def Cube "Merged" (
    references = [ @a.usda@ ]
)
{
}
`);
    expect(out).toContain("[ @a.usda@ ]");
    expect(out).not.toContain("usdbee_ref_");
  });
});

describe("payload = → prepend references =", () => {
  it("rewrites payload with and without composition arc keyword", () => {
    const out = patch(`#usda 1.0

def Cube "A" (
    payload = @payload1.usda@
)
{
}

def Cube "B" (
    add payload = @payload2.usda@
)
{
}
`);
    expect(out).toContain("prepend references = @payload1.usda@");
    expect(out).toContain("prepend references = @payload2.usda@");
    expect(out).not.toContain("payload =");
  });

  it("does not touch files without payload", () => {
    passthrough(`#usda 1.0

def Cube "A"
{
    double size = 1
}
`);
  });
});

describe("variantSet → def Xform", () => {
  it("converts variantSet blocks", () => {
    const out = patch(`#usda 1.0

variantSet "shadingVariant" = {
    "red" {
    }
    "blue" {
    }
}
`);
    expect(out).toContain('def Xform "variantSet_shadingVariant" {');
    expect(out).not.toContain('variantSet "shadingVariant"');
  });
});

describe("variant selector blocks → def Xform", () => {
  // observed quirk: the rename regex only matches [A-Za-z0-9_]+ names, so a
  // variant value like ":red" is never renamed to usdbee_v_*
  it("does not rename variant blocks with non-identifier names", () => {
    passthrough(`#usda 1.0

def Xform "A"
{
    variants = {
        string shadingVariant = ":red"
    }
    ":red" {
        double radius = 1
    }
}
`);
  });

  it("renames non-default variants too (both regex branches behave identically)", () => {
    const out = patch(`#usda 1.0

def Xform "A" (
    variants = {
        string shading = "red"
    }
)
{
    "red" {
        double radius = 1
    }
    "blue" {
        double radius = 2
    }
}
`);
    expect(out).toContain('def Xform "usdbee_v_red"');
    expect(out).toContain('def Xform "usdbee_v_blue"');
  });
});

describe("PointInstancer expansion", () => {
  it("expands instancer into one Xform per position (note z,y,x reorder of translate)", () => {
    const out = patch(`#usda 1.0

def PointInstancer "Forest" {
    point3f[] positions = [ (1, 0, 3), (5, 0, 7) ]
    def Xform "Tree" (prepend references = @tree.usda@)
    {
    }
}
`);
    expect(out).toContain('def Xform "Forest" {');
    expect(out).toContain('def Xform "Tree_inst_0" (');
    expect(out).toContain('def Xform "Tree_inst_1" (');
    expect(out).toContain("double3 xformOp:translate = (3, 0, 1)");
    expect(out).toContain("double3 xformOp:translate = (7, 0, 5)");
    expect(out).toContain("prepend references = @tree.usda@");
    expect(out).not.toContain("PointInstancer");
  });
});

describe("subLayers → appended reference Xforms", () => {
  it("appends a dummy reference Xform per sublayer at end of file", () => {
    const input = `#usda 1.0 (
    subLayers = [
        @base.usda@,
        @extra.usda@
    ]
)

def Xform "Main"
{
}
`;
    const out = patch(input);
    expect(out).toContain('def Xform "usdbee_sublayer_0" (');
    expect(out).toContain("prepend references = @base.usda@");
    expect(out).toContain('def Xform "usdbee_sublayer_1" (');
    expect(out).toContain("prepend references = @extra.usda@");
    // injections land at the end of the layer
    expect(out.indexOf("usdbee_sublayer_0")).toBeGreaterThan(out.indexOf('def Xform "Main"'));
  });

  it("leaves layers without subLayers unchanged", () => {
    passthrough(`#usda 1.0

def Xform "Main"
{
}
`);
  });
});

describe("matrix4d flattening", () => {
  it("flattens nested row tuples into a 16-element tuple", () => {
    const out = patch(`#usda 1.0

def Xform "M"
{
    matrix4d xformOp:transform = (
        (1, 2, 3, 4),
        (5, 6, 7, 8),
        (9, 10, 11, 12),
        (13, 14, 15, 16)
    )
}
`);
    expect(out).toContain(
      "matrix4d xformOp:transform = ( 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 )",
    );
  });

  it("keeps already-flat matrices unchanged", () => {
    passthrough(`#usda 1.0

def Xform "M"
{
    matrix4d xformOp:transform = ( 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 )
}
`);
  });
});

import { describe, expect, it } from "vitest";

import { parseXmlDocument } from "../src/formats/xml.js";

const REAL_TMX = `<?xml version="1.0" encoding="UTF-8"?>
<map version="1.10" tiledversion="1.12.2" orientation="orthogonal" renderorder="right-down" width="2" height="2" tilewidth="16" tileheight="16" infinite="0" nextlayerid="3" nextobjectid="2">
 <tileset firstgid="1" source="tiles.tsx"/>
 <layer id="1" name="ground &amp; base" width="2" height="2">
  <data encoding="csv">
1,0,
0,2
</data>
 </layer>
 <objectgroup id="2" name="objects">
  <object id="1" name="spawn" x="8" y="8">
   <point/>
  </object>
 </objectgroup>
</map>
`;

describe("bounded Tiled XML parsing", () => {
  it("parses real Tiled writer output with entities and nesting", () => {
    const root = parseXmlDocument(
      REAL_TMX,
      "maps/level.tmx",
    );
    expect(root.name).toBe("map");
    expect(root.attributes).toMatchObject({
      orientation: "orthogonal",
      width: "2",
      infinite: "0",
    });
    expect(
      root.children.map((child) => child.name),
    ).toEqual([
      "tileset",
      "layer",
      "objectgroup",
    ]);
    const layer = root.children[1]!;
    expect(layer.attributes.name).toBe(
      "ground & base",
    );
    const data = layer.children[0]!;
    expect(data.attributes.encoding).toBe("csv");
    expect(data.text.trim()).toBe("1,0,\n0,2");
    const object =
      root.children[2]!.children[0]!;
    expect(object.children[0]!.name).toBe(
      "point",
    );
  });

  it("fails closed on the XML surface outside Tiled's writer subset", () => {
    const cases = [
      // XXE / entity surface
      '<?xml version="1.0"?><!DOCTYPE map [<!ENTITY x "y">]><map/>',
      "<map>&xxe;</map>",
      // Processing instructions and CDATA
      "<map><?php echo 1 ?></map>",
      "<map><![CDATA[x]]></map>",
      // Structural damage
      "<map><layer></map>",
      "<map></map><map/>",
      '<map a="1" a="2"/>',
      "<ns:map/>",
      '<map a=1/>',
      "<map>a & b</map>",
    ];
    for (const source of cases) {
      expect(() =>
        parseXmlDocument(source, "maps/bad.tmx"),
      ).toThrow(
        expect.objectContaining({
          code: "UNSUPPORTED_FORMAT",
        }),
      );
    }
  });

  it("bounds nesting depth", () => {
    const deep =
      "<a>".repeat(100) + "</a>".repeat(100);
    expect(() =>
      parseXmlDocument(deep, "maps/deep.tmx"),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_FORMAT",
      }),
    );
  });
});

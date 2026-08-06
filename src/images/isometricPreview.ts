import { TiledMcpError } from "../errors.js";
import {
  hexagonalTileToScreen,
  type HexagonalGeometry,
} from "../maps/coordinates.js";
import { decodeGid } from "../maps/gid.js";
import { type NativePreviewAtlas } from "./mapPreview.js";

export const MAX_ISOMETRIC_REGION_CELLS = 20_000;
export const MAX_ISOMETRIC_RENDER_PIXELS = 1_500_000;
export const MAX_ISOMETRIC_RENDER_SCALE = 4;

export interface IsometricRenderLayer {
  id: number;
  name: string;
  opacity: number;
  /** Region-local raw GIDs in row-major order, flip bits included. */
  gids: readonly number[];
}

/**
 * Composites the tile layers of one isometric region using the exact
 * Tiled 1.12.2 IsometricRenderer placement: the diamond's screen
 * origin sits at regionHeight*tileWidth/2, each cell's tile image
 * anchors bottom-left at (top corner - tileWidth/2, top corner +
 * tileHeight), and cells paint in diagonal scanline order (ascending
 * x+y, then ascending x) so overlaps resolve like the editor. Atlas
 * tiles match the grid size by construction (the loader enforces it),
 * horizontal/vertical flips mirror the sample, and the anti-diagonal
 * rotation flag fails closed.
 */
export function renderIsometricTiles(input: {
  tileWidth: number;
  tileHeight: number;
  regionWidth: number;
  regionHeight: number;
  layers: readonly IsometricRenderLayer[];
  atlases: readonly NativePreviewAtlas[];
  scale: number;
}): {
  rgba: Buffer;
  width: number;
  height: number;
} {
  const {
    tileWidth,
    tileHeight,
    regionWidth,
    regionHeight,
    scale,
  } = input;
  if (
    tileWidth % 2 !== 0 ||
    tileHeight % 2 !== 0
  ) {
    throw new TiledMcpError(
      "UNSUPPORTED_RENDER_FEATURE",
      "Isometric rendering requires even map tile dimensions so half-tile screen steps stay integral.",
      {
        feature: "isometric-tile-size",
        tileWidth,
        tileHeight,
      },
    );
  }
  const side = regionWidth + regionHeight;
  const width = (side * tileWidth * scale) / 2;
  const height = (side * tileHeight * scale) / 2;
  if (
    width * height >
    MAX_ISOMETRIC_RENDER_PIXELS
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `The isometric render would exceed ${MAX_ISOMETRIC_RENDER_PIXELS} pixels; shrink the region or the scale.`,
      { limit: MAX_ISOMETRIC_RENDER_PIXELS },
    );
  }
  const canvas = Buffer.alloc(width * height * 4);
  const originX =
    (regionHeight * tileWidth) / 2;

  const atlasFor = (
    baseGid: number,
  ): {
    atlas: NativePreviewAtlas;
    localId: number;
  } => {
    for (const atlas of input.atlases) {
      if (
        baseGid >= atlas.firstGid &&
        baseGid < atlas.firstGid + atlas.tileCount
      ) {
        return {
          atlas,
          localId: baseGid - atlas.firstGid,
        };
      }
    }
    throw new TiledMcpError(
      "GID_OUT_OF_RANGE",
      `GID ${baseGid} does not fall inside any loaded tileset range.`,
      { gid: baseGid },
    );
  };

  for (const layer of input.layers) {
    // Diagonal scanlines reproduce the editor's painting order.
    for (
      let diagonal = 0;
      diagonal <= side - 2;
      diagonal += 1
    ) {
      const firstX = Math.max(
        0,
        diagonal - regionHeight + 1,
      );
      const lastX = Math.min(
        regionWidth - 1,
        diagonal,
      );
      for (let x = firstX; x <= lastX; x += 1) {
        const y = diagonal - x;
        const gid =
          layer.gids[y * regionWidth + x]!;
        if (gid === 0) {
          continue;
        }
        const decoded = decodeGid(
          gid,
          "isometric",
        );
        if (
          decoded.transform.kind ===
            "orthogonal" &&
          decoded.transform.flipD
        ) {
          throw new TiledMcpError(
            "UNSUPPORTED_RENDER_FEATURE",
            "Anti-diagonally flipped isometric cells are outside the isometric render profile.",
            {
              feature:
                "isometric-antidiagonal-flip",
              layerId: layer.id,
              x,
              y,
            },
          );
        }
        const flipH =
          decoded.transform.kind === "orthogonal"
            ? decoded.transform.flipH
            : false;
        const flipV =
          decoded.transform.kind === "orthogonal"
            ? decoded.transform.flipV
            : false;
        const { atlas, localId } = atlasFor(
          decoded.baseGid,
        );
        if (localId >= atlas.geometry.tileCount) {
          throw new TiledMcpError(
            "GID_OUT_OF_RANGE",
            `Local tile ${localId} does not exist in ${atlas.assetId}.`,
            {
              assetId: atlas.assetId,
              localId,
            },
          );
        }
        const column =
          localId % atlas.geometry.columns;
        const row = Math.floor(
          localId / atlas.geometry.columns,
        );
        const sourceLeft =
          atlas.geometry.margin +
          column *
            (atlas.geometry.tileWidth +
              atlas.geometry.spacing);
        const sourceTop =
          atlas.geometry.margin +
          row *
            (atlas.geometry.tileHeight +
              atlas.geometry.spacing);
        // Top diamond corner of the cell, region-local.
        const cornerX =
          ((x - y) * tileWidth) / 2 + originX;
        const cornerY =
          ((x + y) * tileHeight) / 2;
        const destLeft =
          (cornerX - tileWidth / 2) * scale;
        const destTop = cornerY * scale;
        const alphaScale = layer.opacity;
        for (
          let py = 0;
          py < tileHeight * scale;
          py += 1
        ) {
          const sampleY = flipV
            ? tileHeight -
              1 -
              Math.floor(py / scale)
            : Math.floor(py / scale);
          const canvasY = destTop + py;
          if (canvasY < 0 || canvasY >= height) {
            continue;
          }
          for (
            let px = 0;
            px < tileWidth * scale;
            px += 1
          ) {
            const sampleX = flipH
              ? tileWidth -
                1 -
                Math.floor(px / scale)
              : Math.floor(px / scale);
            const canvasX = destLeft + px;
            if (
              canvasX < 0 ||
              canvasX >= width
            ) {
              continue;
            }
            const sourceIndex =
              ((sourceTop + sampleY) *
                atlas.geometry.imageWidth +
                sourceLeft +
                sampleX) *
              4;
            const alpha =
              (atlas.rgba[sourceIndex + 3]! /
                255) *
              alphaScale;
            if (alpha <= 0) {
              continue;
            }
            const destIndex =
              (canvasY * width + canvasX) * 4;
            const inverse = 1 - alpha;
            for (
              let channel = 0;
              channel < 3;
              channel += 1
            ) {
              canvas[destIndex + channel] =
                Math.round(
                  atlas.rgba[
                    sourceIndex + channel
                  ]! *
                    alpha +
                    canvas[
                      destIndex + channel
                    ]! *
                      inverse,
                );
            }
            canvas[destIndex + 3] = Math.round(
              255 * alpha +
                canvas[destIndex + 3]! *
                  inverse,
            );
          }
        }
      }
    }
  }
  return { rgba: canvas, width, height };
}

export type HexagonalRenderParams =
  HexagonalGeometry;

/**
 * Computes one cell's top-left screen pixel with the exact Tiled
 * 1.12.2 HexagonalRenderer::tileToScreenCoords math (staggered maps
 * are the hexSideLength=0 degenerate case, matching the official
 * class hierarchy).
 *
 * This used to carry its own copy of the arithmetic, which drifted from the
 * original in one place: it stepped rows and columns by the map's *declared*
 * tile size where Tiled uses the derived `RenderParams` size. The two agree
 * unless `tileSize - sideLength` is odd, so hexagonal maps matched and only
 * odd-dimension staggered maps drifted -- cumulatively, one pixel per row. The
 * transform now lives in one place and is shared with
 * `tiled_convert_coordinates`, so a cell's rendered position and its reported
 * position cannot disagree again.
 */
export function hexTileToScreen(
  params: HexagonalRenderParams,
  x: number,
  y: number,
): { x: number; y: number } {
  return hexagonalTileToScreen(params, x, y);
}

/**
 * Composites staggered/hexagonal tile layers: every region cell's
 * screen position comes from the official transform, the canvas is
 * the tight bounding box of the region's cells, and cells paint in
 * (screenY, screenX) order — equivalent to the editor's row order on
 * both stagger axes. Flip semantics: H/V mirror the sample; the
 * hexagonal rotation flags fail closed.
 */
export function renderHexagonalTiles(input: {
  params: HexagonalRenderParams;
  region: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  layers: readonly IsometricRenderLayer[];
  atlases: readonly NativePreviewAtlas[];
  scale: number;
}): {
  rgba: Buffer;
  width: number;
  height: number;
  originPixel: { x: number; y: number };
} {
  const { params, region, scale } = input;
  const positions: Array<{
    x: number;
    y: number;
  }> = [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      const position = hexTileToScreen(
        params,
        region.x + x,
        region.y + y,
      );
      positions.push(position);
      minX = Math.min(minX, position.x);
      minY = Math.min(minY, position.y);
      maxX = Math.max(maxX, position.x);
      maxY = Math.max(maxY, position.y);
    }
  }
  const width =
    (maxX - minX + params.tileWidth) * scale;
  const height =
    (maxY - minY + params.tileHeight) * scale;
  if (
    width * height >
    MAX_ISOMETRIC_RENDER_PIXELS
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `The render would exceed ${MAX_ISOMETRIC_RENDER_PIXELS} pixels; shrink the region or the scale.`,
      { limit: MAX_ISOMETRIC_RENDER_PIXELS },
    );
  }
  const canvas = Buffer.alloc(width * height * 4);

  const atlasFor = (
    baseGid: number,
  ): {
    atlas: NativePreviewAtlas;
    localId: number;
  } => {
    for (const atlas of input.atlases) {
      if (
        baseGid >= atlas.firstGid &&
        baseGid < atlas.firstGid + atlas.tileCount
      ) {
        return {
          atlas,
          localId: baseGid - atlas.firstGid,
        };
      }
    }
    throw new TiledMcpError(
      "GID_OUT_OF_RANGE",
      `GID ${baseGid} does not fall inside any loaded tileset range.`,
      { gid: baseGid },
    );
  };

  for (const layer of input.layers) {
    const draws: Array<{
      screenX: number;
      screenY: number;
      gid: number;
    }> = [];
    for (let y = 0; y < region.height; y += 1) {
      for (
        let x = 0;
        x < region.width;
        x += 1
      ) {
        const gid =
          layer.gids[y * region.width + x]!;
        if (gid === 0) {
          continue;
        }
        const position =
          positions[y * region.width + x]!;
        draws.push({
          screenX: position.x - minX,
          screenY: position.y - minY,
          gid,
        });
      }
    }
    draws.sort(
      (a, b) =>
        a.screenY - b.screenY ||
        a.screenX - b.screenX,
    );
    for (const draw of draws) {
      const decoded = decodeGid(
        draw.gid,
        "hexagonal",
      );
      if (
        decoded.transform.kind ===
          "hexagonal" &&
        (decoded.transform.rotate60 ||
          decoded.transform.rotate120)
      ) {
        throw new TiledMcpError(
          "UNSUPPORTED_RENDER_FEATURE",
          "Hexagonally rotated cells are outside the staggered/hexagonal render profile.",
          { feature: "hexagonal-rotation" },
        );
      }
      const flipH =
        decoded.transform.kind === "hexagonal"
          ? decoded.transform.flipH
          : false;
      const flipV =
        decoded.transform.kind === "hexagonal"
          ? decoded.transform.flipV
          : false;
      const { atlas, localId } = atlasFor(
        decoded.baseGid,
      );
      if (localId >= atlas.geometry.tileCount) {
        throw new TiledMcpError(
          "GID_OUT_OF_RANGE",
          `Local tile ${localId} does not exist in ${atlas.assetId}.`,
          { assetId: atlas.assetId, localId },
        );
      }
      const column =
        localId % atlas.geometry.columns;
      const row = Math.floor(
        localId / atlas.geometry.columns,
      );
      const sourceLeft =
        atlas.geometry.margin +
        column *
          (atlas.geometry.tileWidth +
            atlas.geometry.spacing);
      const sourceTop =
        atlas.geometry.margin +
        row *
          (atlas.geometry.tileHeight +
            atlas.geometry.spacing);
      const destLeft = draw.screenX * scale;
      const destTop = draw.screenY * scale;
      const alphaScale = layer.opacity;
      for (
        let py = 0;
        py < params.tileHeight * scale;
        py += 1
      ) {
        const sampleY = flipV
          ? params.tileHeight -
            1 -
            Math.floor(py / scale)
          : Math.floor(py / scale);
        const canvasY = destTop + py;
        if (canvasY < 0 || canvasY >= height) {
          continue;
        }
        for (
          let px = 0;
          px < params.tileWidth * scale;
          px += 1
        ) {
          const sampleX = flipH
            ? params.tileWidth -
              1 -
              Math.floor(px / scale)
            : Math.floor(px / scale);
          const canvasX = destLeft + px;
          if (canvasX < 0 || canvasX >= width) {
            continue;
          }
          const sourceIndex =
            ((sourceTop + sampleY) *
              atlas.geometry.imageWidth +
              sourceLeft +
              sampleX) *
            4;
          const alpha =
            (atlas.rgba[sourceIndex + 3]! /
              255) *
            alphaScale;
          if (alpha <= 0) {
            continue;
          }
          const destIndex =
            (canvasY * width + canvasX) * 4;
          const inverse = 1 - alpha;
          for (
            let channel = 0;
            channel < 3;
            channel += 1
          ) {
            canvas[destIndex + channel] =
              Math.round(
                atlas.rgba[
                  sourceIndex + channel
                ]! *
                  alpha +
                  canvas[destIndex + channel]! *
                    inverse,
              );
          }
          canvas[destIndex + 3] = Math.round(
            255 * alpha +
              canvas[destIndex + 3]! * inverse,
          );
        }
      }
    }
  }
  return {
    rgba: canvas,
    width,
    height,
    originPixel: {
      x: -minX * scale || 0,
      y: -minY * scale || 0,
    },
  };
}

import { TiledMcpError } from "../errors.js";
import {
  cloneJson,
  expectObject,
  type JsonObject,
} from "../formats/json.js";

const SHAPE_MEMBERS = [
  "point",
  "ellipse",
  "capsule",
  "polygon",
  "polyline",
] as const;

/**
 * Validates one JSON object template document and returns its template
 * object. V1 covers non-tile templates: a template-level tileset
 * reference or a tile object fails closed, as does a nested template.
 */
export function readObjectTemplate(
  document: JsonObject,
  templatePath: string,
): JsonObject {
  if (document.type !== "template") {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${templatePath} is not a Tiled object template.`,
      { path: templatePath },
    );
  }
  if (document.tileset !== undefined) {
    throw new TiledMcpError(
      "UNSUPPORTED_OBJECT_PROFILE",
      `${templatePath} carries a tileset reference; tile object templates are outside the supported reading profile.`,
      { path: templatePath },
    );
  }
  const object = expectObject(
    document.object,
    `${templatePath}.object`,
  );
  if (object.gid !== undefined) {
    throw new TiledMcpError(
      "UNSUPPORTED_OBJECT_PROFILE",
      `${templatePath} templates a tile object, which is outside the supported reading profile.`,
      { path: templatePath },
    );
  }
  if (object.template !== undefined) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${templatePath} nests another template reference.`,
      { path: templatePath },
    );
  }
  return object;
}

/**
 * Merges a template instance with its template object using the exact
 * Tiled 1.12.2 `MapObject::syncWithTemplate` rules:
 *
 * - `name` overrides only when the instance name is a nonempty string;
 * - size overrides only when both instance width and height are > 0
 *   (`QSizeF::isEmpty`), and always as a pair;
 * - the shape overrides only when the instance carries one of the five
 *   shape members — an instance `text` member overrides the text data
 *   but deliberately not the template's shape;
 * - `rotation`, `opacity`, and `visible` override exactly when the
 *   instance serializes the member;
 * - `id`, `x`, `y`, `class`/`type`, and custom properties always come
 *   from the instance (Tiled does not synchronize them).
 *
 * A nonzero instance gid is a tile instance and fails closed upstream.
 * The returned object drops the `template` member so it projects like a
 * plain object.
 */
export function mergeTemplateInstance(
  instance: JsonObject,
  templateObject: JsonObject,
): JsonObject {
  const merged: JsonObject = cloneJson(
    instance,
  ) as JsonObject;
  delete merged.template;

  if (
    typeof instance.name !== "string" ||
    instance.name.length === 0
  ) {
    if (templateObject.name !== undefined) {
      merged.name = cloneJson(
        templateObject.name,
      );
    } else {
      delete merged.name;
    }
  }

  const instanceWidth =
    typeof instance.width === "number"
      ? instance.width
      : 0;
  const instanceHeight =
    typeof instance.height === "number"
      ? instance.height
      : 0;
  if (
    !(instanceWidth > 0 && instanceHeight > 0)
  ) {
    for (const member of [
      "width",
      "height",
    ] as const) {
      if (templateObject[member] !== undefined) {
        merged[member] = cloneJson(
          templateObject[member],
        );
      } else {
        delete merged[member];
      }
    }
  }

  const shapeOverridden = SHAPE_MEMBERS.some(
    (member) =>
      Object.prototype.hasOwnProperty.call(
        instance,
        member,
      ),
  );
  if (!shapeOverridden) {
    for (const member of SHAPE_MEMBERS) {
      if (templateObject[member] !== undefined) {
        merged[member] = cloneJson(
          templateObject[member],
        );
      } else {
        delete merged[member];
      }
    }
  }

  if (
    !Object.prototype.hasOwnProperty.call(
      instance,
      "text",
    )
  ) {
    if (templateObject.text !== undefined) {
      merged.text = cloneJson(
        templateObject.text,
      );
    } else {
      delete merged.text;
    }
  }

  for (const member of [
    "rotation",
    "opacity",
    "visible",
  ] as const) {
    if (
      !Object.prototype.hasOwnProperty.call(
        instance,
        member,
      ) &&
      templateObject[member] !== undefined
    ) {
      merged[member] = cloneJson(
        templateObject[member],
      );
    }
  }

  return merged;
}

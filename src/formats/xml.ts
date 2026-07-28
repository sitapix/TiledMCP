import { TiledMcpError } from "../errors.js";

export const MAX_XML_BYTES = 32 * 1024 * 1024;
export const MAX_XML_DEPTH = 64;
export const MAX_XML_NODES = 500_000;
export const MAX_XML_ATTRIBUTES_PER_ELEMENT = 64;

/**
 * One parsed XML element. Text content is concatenated across child text
 * nodes (sufficient for Tiled documents, where mixed content never
 * carries meaning); child elements preserve document order.
 */
export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/u;
const BUILTIN_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

/**
 * Bounded, fail-closed XML parser for the subset Tiled's QXmlStreamWriter
 * emits. Deliberately rejects everything outside that subset instead of
 * approximating it: DOCTYPE declarations (no entity or XXE surface),
 * processing instructions other than the leading XML declaration,
 * CDATA sections, namespace-prefixed names, and non-built-in entity
 * references all fail closed.
 */
export function parseXmlDocument(
  source: string,
  projectPath: string,
): XmlElement {
  if (
    Buffer.byteLength(source, "utf8") >
    MAX_XML_BYTES
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${projectPath} exceeds the ${MAX_XML_BYTES} byte XML limit.`,
      { path: projectPath, limit: MAX_XML_BYTES },
    );
  }
  const parser = new Parser(source, projectPath);
  return parser.parse();
}

class Parser {
  private position = 0;
  private nodeCount = 0;

  constructor(
    private readonly source: string,
    private readonly projectPath: string,
  ) {}

  parse(): XmlElement {
    this.skipBom();
    this.skipProlog();
    const root = this.parseElement(0);
    this.skipMisc();
    if (this.position < this.source.length) {
      throw this.fail(
        "content after the document element",
      );
    }
    return root;
  }

  private fail(reason: string): TiledMcpError {
    return new TiledMcpError(
      "UNSUPPORTED_FORMAT",
      `${this.projectPath} is not parseable Tiled XML: ${reason} (offset ${this.position}).`,
      {
        path: this.projectPath,
        offset: this.position,
      },
    );
  }

  private skipBom(): void {
    if (this.source.startsWith("﻿")) {
      this.position = 1;
    }
  }

  private skipWhitespace(): void {
    while (
      this.position < this.source.length &&
      " \t\r\n".includes(
        this.source[this.position]!,
      )
    ) {
      this.position += 1;
    }
  }

  private skipProlog(): void {
    this.skipWhitespace();
    if (this.source.startsWith("<?xml", this.position)) {
      const end = this.source.indexOf(
        "?>",
        this.position,
      );
      if (end < 0) {
        throw this.fail(
          "unterminated XML declaration",
        );
      }
      this.position = end + 2;
    }
    this.skipMisc();
  }

  private skipMisc(): void {
    for (;;) {
      this.skipWhitespace();
      if (
        this.source.startsWith(
          "<!--",
          this.position,
        )
      ) {
        const end = this.source.indexOf(
          "-->",
          this.position + 4,
        );
        if (end < 0) {
          throw this.fail("unterminated comment");
        }
        this.position = end + 3;
        continue;
      }
      if (
        this.source.startsWith(
          "<!DOCTYPE",
          this.position,
        ) ||
        this.source.startsWith(
          "<![",
          this.position,
        ) ||
        this.source.startsWith(
          "<?",
          this.position,
        )
      ) {
        throw this.fail(
          "DOCTYPE, CDATA, and processing instructions are rejected",
        );
      }
      return;
    }
  }

  private parseElement(depth: number): XmlElement {
    if (depth >= MAX_XML_DEPTH) {
      throw this.fail(
        `elements nest deeper than ${MAX_XML_DEPTH}`,
      );
    }
    this.nodeCount += 1;
    if (this.nodeCount > MAX_XML_NODES) {
      throw this.fail(
        `the document exceeds ${MAX_XML_NODES} nodes`,
      );
    }
    if (this.source[this.position] !== "<") {
      throw this.fail("expected an element");
    }
    this.position += 1;
    const name = this.parseName();
    const attributes: Record<string, string> = {};
    let attributeCount = 0;
    for (;;) {
      this.skipWhitespace();
      const char = this.source[this.position];
      if (char === "/") {
        if (
          this.source[this.position + 1] !== ">"
        ) {
          throw this.fail(
            "malformed self-closing tag",
          );
        }
        this.position += 2;
        return {
          name,
          attributes,
          children: [],
          text: "",
        };
      }
      if (char === ">") {
        this.position += 1;
        break;
      }
      const attributeName = this.parseName();
      this.skipWhitespace();
      if (this.source[this.position] !== "=") {
        throw this.fail(
          "attribute without a value",
        );
      }
      this.position += 1;
      this.skipWhitespace();
      const quote = this.source[this.position];
      if (quote !== '"' && quote !== "'") {
        throw this.fail(
          "unquoted attribute value",
        );
      }
      this.position += 1;
      const end = this.source.indexOf(
        quote,
        this.position,
      );
      if (end < 0) {
        throw this.fail(
          "unterminated attribute value",
        );
      }
      const raw = this.source.slice(
        this.position,
        end,
      );
      if (raw.includes("<")) {
        throw this.fail(
          "raw < inside an attribute value",
        );
      }
      if (
        Object.prototype.hasOwnProperty.call(
          attributes,
          attributeName,
        )
      ) {
        throw this.fail(
          `duplicate attribute ${attributeName}`,
        );
      }
      attributeCount += 1;
      if (
        attributeCount >
        MAX_XML_ATTRIBUTES_PER_ELEMENT
      ) {
        throw this.fail(
          `more than ${MAX_XML_ATTRIBUTES_PER_ELEMENT} attributes on one element`,
        );
      }
      attributes[attributeName] =
        this.decodeEntities(raw);
      this.position = end + 1;
    }

    const children: XmlElement[] = [];
    let text = "";
    for (;;) {
      const nextTag = this.source.indexOf(
        "<",
        this.position,
      );
      if (nextTag < 0) {
        throw this.fail(
          `unterminated element ${name}`,
        );
      }
      if (nextTag > this.position) {
        text += this.decodeEntities(
          this.source.slice(
            this.position,
            nextTag,
          ),
        );
        this.position = nextTag;
      }
      if (
        this.source.startsWith(
          "<!--",
          this.position,
        )
      ) {
        const end = this.source.indexOf(
          "-->",
          this.position + 4,
        );
        if (end < 0) {
          throw this.fail("unterminated comment");
        }
        this.position = end + 3;
        continue;
      }
      if (
        this.source.startsWith(
          "</",
          this.position,
        )
      ) {
        this.position += 2;
        const closing = this.parseName();
        if (closing !== name) {
          throw this.fail(
            `mismatched closing tag ${closing} for ${name}`,
          );
        }
        this.skipWhitespace();
        if (this.source[this.position] !== ">") {
          throw this.fail(
            "malformed closing tag",
          );
        }
        this.position += 1;
        return { name, attributes, children, text };
      }
      if (
        this.source.startsWith(
          "<!",
          this.position,
        ) ||
        this.source.startsWith(
          "<?",
          this.position,
        )
      ) {
        throw this.fail(
          "DOCTYPE, CDATA, and processing instructions are rejected",
        );
      }
      children.push(
        this.parseElement(depth + 1),
      );
    }
  }

  private parseName(): string {
    const start = this.position;
    while (
      this.position < this.source.length &&
      /[A-Za-z0-9._-]/u.test(
        this.source[this.position]!,
      )
    ) {
      this.position += 1;
    }
    const name = this.source.slice(
      start,
      this.position,
    );
    if (!NAME_PATTERN.test(name)) {
      throw this.fail(
        "invalid or namespace-prefixed name",
      );
    }
    return name;
  }

  private decodeEntities(value: string): string {
    if (!value.includes("&")) {
      return value;
    }
    return value.replace(
      /&(#x?[0-9A-Fa-f]+|[A-Za-z]+);|&/gu,
      (_match, body: string | undefined) => {
        if (body === undefined) {
          throw this.fail(
            "raw & outside an entity reference",
          );
        }
        if (body.startsWith("#x") || body.startsWith("#X")) {
          const code = Number.parseInt(
            body.slice(2),
            16,
          );
          return this.codePoint(code);
        }
        if (body.startsWith("#")) {
          const code = Number.parseInt(
            body.slice(1),
            10,
          );
          return this.codePoint(code);
        }
        const builtin = BUILTIN_ENTITIES[body];
        if (builtin === undefined) {
          throw this.fail(
            `unsupported entity &${body};`,
          );
        }
        return builtin;
      },
    );
  }

  private codePoint(code: number): string {
    if (
      !Number.isSafeInteger(code) ||
      code < 0x9 ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      throw this.fail(
        "invalid character reference",
      );
    }
    return String.fromCodePoint(code);
  }
}

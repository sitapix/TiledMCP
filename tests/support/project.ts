import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ChangeSetRegistry } from "../../src/changeSets.js";
import type { JsonObject } from "../../src/formats/json.js";
import { MapService } from "../../src/maps/mapService.js";
import { ProjectPathResolver } from "../../src/project/pathResolver.js";
import {
  DocumentStore,
  type DocumentWriteObserver,
} from "../../src/storage/documentStore.js";
import type { CheckpointStoreOptions } from "../../src/storage/checkpoints.js";

/**
 * The DocumentStore constructor's optional tail, named. Suites that need a
 * custom retention policy or a write observer pass these instead of dropping
 * back to constructing the store by hand.
 */
export interface DocumentStoreOptions {
  // `| undefined` is required under exactOptionalPropertyTypes: callers
  // forward values that may legitimately be undefined.
  maxDocumentBytes?: number | undefined;
  writeObserver?: DocumentWriteObserver | undefined;
  checkpointOptions?: CheckpointStoreOptions | undefined;
  transactionObserver?:
    | {
        beforeStep?: (
          step: string,
        ) => Promise<void> | void;
      }
    | undefined;
}

/**
 * A temp project plus the wiring every map test needs.
 *
 * The suite's hand-rolled harnesses all built this -- mkdtemp, a resolver, a
 * store and a service -- and differed only in which fixture files they wrote.
 * The wiring lives here so a constructor change is one edit, and so a new test
 * can start from an assertion instead of from a temp-directory dance.
 */
export interface TestProject {
  root: string;
  resolver: ProjectPathResolver;
  store: DocumentStore;
  service: MapService;
  changeSets: ChangeSetRegistry;
  /** Absolute path for a project-relative path. */
  path(relative: string): string;
  /** Write (or overwrite) a file, creating parent directories. */
  write(
    relative: string,
    content: JsonObject | Buffer | string,
  ): Promise<void>;
}

export interface ProjectSpec {
  /** Files to create, keyed by project-relative path. */
  files?: Record<
    string,
    JsonObject | Buffer | string
  >;
  /** Prefix for the temp directory, to keep failures identifiable. */
  prefix?: string;
  /** Passed through to the DocumentStore constructor. */
  store?: DocumentStoreOptions;
}

async function writeInto(
  root: string,
  relative: string,
  content: JsonObject | Buffer | string,
): Promise<void> {
  const absolute = join(root, relative);
  await mkdir(dirname(absolute), { recursive: true });
  if (Buffer.isBuffer(content)) {
    await writeFile(absolute, content);
    return;
  }
  await writeFile(
    absolute,
    typeof content === "string"
      ? content
      : `${JSON.stringify(content, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Wire the resolver/store/service stack over a directory that already exists.
 *
 * Harnesses that build their own fixture layout use this directly, so the
 * wiring is written once even though the fixtures differ per suite -- a change
 * to DocumentStore's constructor is one edit here rather than 46 across tests.
 */
/**
 * Construct a DocumentStore over an existing resolver.
 *
 * Suites that already hold a resolver (or build the service inline) use this
 * instead of calling the constructor, so the store's construction has exactly
 * one call site across the whole suite.
 */
export function makeStore(
  resolver: ProjectPathResolver,
  options: DocumentStoreOptions = {},
): DocumentStore {
  return new DocumentStore(
    resolver,
    options.maxDocumentBytes,
    options.writeObserver,
    options.checkpointOptions,
    options.transactionObserver,
  );
}

export async function wireProject(
  root: string,
  storeOptions: DocumentStoreOptions = {},
): Promise<TestProject> {
  const resolver =
    await ProjectPathResolver.create(root);
  const store = makeStore(resolver, storeOptions);
  return {
    root,
    resolver,
    store,
    service: new MapService(resolver, store),
    changeSets: new ChangeSetRegistry(),
    path: (relative) => join(root, relative),
    write: (relative, content) =>
      writeInto(root, relative, content),
  };
}

/** A fresh temp directory for a project, named for the suite that owns it. */
export async function makeProjectRoot(
  prefix = "tiledmcp-test",
): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

/** Create a temp project. Callers are responsible for {@link disposeProject}. */
export async function createProject(
  spec: ProjectSpec = {},
): Promise<TestProject> {
  const root = await makeProjectRoot(spec.prefix);
  for (const [relative, content] of Object.entries(
    spec.files ?? {},
  )) {
    await writeInto(root, relative, content);
  }
  return wireProject(root, spec.store);
}

export async function disposeProject(
  project: TestProject,
): Promise<void> {
  await rm(project.root, {
    recursive: true,
    force: true,
  });
}

/**
 * Run `body` against a fresh temp project and always tear it down, including
 * when the body throws -- so a failing assertion cannot leave a temp directory
 * behind the way an early `return` in a hand-rolled harness can.
 */
export async function withProject<T>(
  spec: ProjectSpec,
  body: (project: TestProject) => Promise<T>,
): Promise<T> {
  const project = await createProject(spec);
  try {
    return await body(project);
  } finally {
    await disposeProject(project);
  }
}

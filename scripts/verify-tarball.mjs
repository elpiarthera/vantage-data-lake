#!/usr/bin/env node
// scripts/verify-tarball.mjs — static proof that the published tarball
// packages the component schema (chunks/memories tables + by_org_scope_chunk
// index) SIDE BY SIDE with convex.config.ts.
//
// Root cause (see CHANGELOG 0.3.3): Convex's bundler resolves a component's
// schema.ts relative to the DIRECTORY CONTAINING that component's
// convex.config.ts (node_modules/convex/dist/cli.bundle.cjs,
// bundleImplementations(): `ctx.fs.exists(path.resolve(resolvedPath,
// "schema.ts"))` where `resolvedPath = dirname(convex.config.ts)`). A schema
// file published in a sibling/nested directory that is NOT the same
// directory as convex.config.ts is silently skipped (schema = null) even
// though npm packed it into the tarball — the file is present on disk but
// unreachable by the bundler's lookup.
//
// This script proves, without provisioning any Convex deployment, that the
// packaged tarball has convex.config.ts and schema.ts as siblings, and that
// the by_org_scope_chunk index text is present in the packaged schema.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function fail(message) {
  console.error(`[verify-tarball] FAIL: ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`[verify-tarball] OK: ${message}`);
}

const repoRoot = process.cwd();
const workDir = mkdtempSync(path.join(tmpdir(), "data-lake-tarball-"));

try {
  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", workDir],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const [{ filename }] = JSON.parse(packOutput);
  const tarballPath = path.join(workDir, filename);
  ok(`packed ${filename}`);

  execFileSync("tar", ["-xzf", tarballPath, "-C", workDir], { cwd: workDir });
  const pkgDir = path.join(workDir, "package");

  const configPath = path.join(pkgDir, "component", "convex.config.ts");
  const schemaPath = path.join(pkgDir, "component", "schema.ts");

  let configDirOk = false;
  try {
    readFileSync(configPath, "utf8");
    readFileSync(schemaPath, "utf8");
    configDirOk = path.dirname(configPath) === path.dirname(schemaPath);
  } catch (err) {
    fail(`could not read ${configPath} or ${schemaPath}: ${err.message}`);
  }

  if (configDirOk) {
    ok(
      `convex.config.ts and schema.ts are siblings: ${path.dirname(configPath)}`,
    );
  } else {
    fail(
      "convex.config.ts and schema.ts are NOT in the same directory inside the tarball — " +
        "the Convex bundler will not find this component's schema at install time.",
    );
  }

  let schemaSource = "";
  try {
    schemaSource = readFileSync(schemaPath, "utf8");
  } catch {
    // already reported above
  }

  const hasChunksTable = schemaSource.includes('chunks: defineTable({');
  const hasIndex = schemaSource.includes(
    '.index("by_org_scope_chunk", ["orgId", "scope", "chunk_id"])',
  );

  if (hasChunksTable) {
    ok("packaged schema.ts declares the `chunks` table");
  } else {
    fail("packaged schema.ts is missing the `chunks` table declaration");
  }

  if (hasIndex) {
    ok("packaged schema.ts declares the `by_org_scope_chunk` index");
  } else {
    fail("packaged schema.ts is missing the `by_org_scope_chunk` index");
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error("[verify-tarball] one or more checks FAILED");
} else {
  console.log("[verify-tarball] all checks PASSED");
}

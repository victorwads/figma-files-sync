import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "figma-cli-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const env = {
    ...process.env,
    FIGMA_ACCESS_TOKEN: "",
    FIGMA_AUTH_COOKIE: "",
    XDG_CONFIG_HOME: path.join(cwd, "auth"),
    APPDATA: path.join(cwd, "auth"),
  };
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
  return { cwd, run };
}
test("help first initializes the directory manifest", async (t) => {
  const f = await fixture(t);
  const result = f.run("--help");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /figma-files-sync/);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(f.cwd, ".sync.fig.json"), "utf8")),
    { schemaVersion: 1, folder: null, files: [] },
  );
});
test("empty fetch and sync work without credentials or a browser", async (t) => {
  const f = await fixture(t);
  for (const command of ["fetch", "sync"]) {
    const result = f.run(command, "--json");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { items: [], errors: [] });
  }
  assert.deepEqual(await readdir(f.cwd), [".sync.fig.json"]);
});
test("auth status uses structured output and does not need credentials", async (t) => {
  const f = await fixture(t);
  const result = f.run("auth", "status", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    tokenConfigured: false,
    browserSessionSaved: false,
    cookieOverride: false,
    validity: "not-checked",
  });
});
test("invalid add initializes manifest but does not register anything", async (t) => {
  const f = await fixture(t);
  const result = f.run("add", "https://evil.example/design/A", "--json");
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /Figma|figma/);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(f.cwd, ".sync.fig.json"), "utf8"))
      .files,
    [],
  );
});
test("malformed manifest prevents even help and remains unchanged", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, ".sync.fig.json"), "invalid");
  const result = f.run("--help");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid/);
  assert.equal(
    await readFile(path.join(f.cwd, ".sync.fig.json"), "utf8"),
    "invalid",
  );
});
test("noninteractive token setup fails with instructions, never hangs", async (t) => {
  const f = await fixture(t);
  const result = f.run("login", "--only-token");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /token-stdin/);
});
test("library import has no directory side effects", async (t) => {
  const f = await fixture(t);
  const url = new URL("../dist/index.js", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "await import(" + JSON.stringify(url) + ")"],
    { cwd: f.cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(f.cwd), []);
});

test("headed and no-headless are accepted before and after the subcommand", async (t) => {
  const f = await fixture(t);
  for (const args of [
    ["--no-headless", "fetch", "--json"],
    ["fetch", "--no-headless", "--json"],
    ["fetch", "--headed", "--json"],
  ]) {
    const r = f.run(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { items: [], errors: [] });
    assert.match(r.stderr, /Starting operation/);
    assert.match(r.stderr, /Reading manifests/);
  }
});
test("operation failures still flush progress to stderr without corrupting JSON", async (t) => {
  const f = await fixture(t);
  const r = f.run("add", "https://figma.com/files/folder/123", "--json");
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /No Figma API token/);
  assert.match(r.stderr, /Loading Figma API credentials/);
  assert.match(r.stderr, /Listing Figma folder 123/);
});

test("concurrency accepts 1–3 tabs and rejects invalid values before work", async (t) => {
  const f = await fixture(t);
  for (const value of ["1", "2", "3"]) {
    const r = f.run("fetch", "--concurrency", value, "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { items: [], errors: [] });
  }
  for (const value of ["0", "4", "-1", "1.5", "abc"]) {
    const r = f.run("sync", "--concurrency", value);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Concurrency/);
  }
});

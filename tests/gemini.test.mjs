import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanGeminiEnv,
  classifyAuthBlob,
  compareVersions,
  checkMinVersion,
  effectiveModel,
  DEFAULT_MODEL,
  MIN_GEMINI_VERSION
} from "../scripts/lib/gemini.mjs";

test("cleanGeminiEnv: drops Anthropic / GitHub / OpenAI / AWS / SSH secrets", () => {
  const fake = {
    PATH: "/usr/bin",
    HOME: "/Users/test",
    GEMINI_API_KEY: "geminisecret",
    ANTHROPIC_API_KEY: "claudesecret",
    GITHUB_TOKEN: "ghsecret",
    GH_TOKEN: "ghsecret2",
    OPENAI_API_KEY: "oaisecret",
    AWS_ACCESS_KEY_ID: "awssecret",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock"
  };
  const cleaned = cleanGeminiEnv(fake);
  assert.equal(cleaned.GEMINI_API_KEY, "geminisecret");
  assert.equal(cleaned.PATH, "/usr/bin");
  assert.equal(cleaned.HOME, "/Users/test");
  assert.equal("ANTHROPIC_API_KEY" in cleaned, false);
  assert.equal("GITHUB_TOKEN" in cleaned, false);
  assert.equal("GH_TOKEN" in cleaned, false);
  assert.equal("OPENAI_API_KEY" in cleaned, false);
  assert.equal("AWS_ACCESS_KEY_ID" in cleaned, false);
  assert.equal("SSH_AUTH_SOCK" in cleaned, false);
});

test("cleanGeminiEnv: keeps locale, terminal, and proxy", () => {
  const fake = {
    LANG: "en_US.UTF-8",
    LC_TIME: "C",
    LC_NUMERIC: "C",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    HTTP_PROXY: "http://proxy:8080",
    HTTPS_PROXY: "http://proxy:8080",
    NO_PROXY: "localhost"
  };
  const cleaned = cleanGeminiEnv(fake);
  assert.equal(cleaned.LANG, "en_US.UTF-8");
  assert.equal(cleaned.LC_TIME, "C");
  assert.equal(cleaned.LC_NUMERIC, "C");
  assert.equal(cleaned.TERM, "xterm-256color");
  assert.equal(cleaned.COLORTERM, "truecolor");
  assert.equal(cleaned.HTTP_PROXY, "http://proxy:8080");
});

test("cleanGeminiEnv: drops random unknown vars", () => {
  const fake = { PATH: "/u", SECRET_THING: "leak", npm_config_cache: "/foo" };
  const cleaned = cleanGeminiEnv(fake);
  assert.equal("SECRET_THING" in cleaned, false);
  assert.equal("npm_config_cache" in cleaned, false);
});

test("cleanGeminiEnv: ignores non-string values (defensive)", () => {
  const fake = { PATH: "/u", BROKEN: 12345, OTHER: { a: 1 } };
  const cleaned = cleanGeminiEnv(fake);
  assert.equal(cleaned.PATH, "/u");
  assert.equal("BROKEN" in cleaned, false);
});

test("classifyAuthBlob: detects no-auth", () => {
  assert.equal(classifyAuthBlob("Please set an Auth method (GEMINI_API_KEY...)"), "no auth method configured");
  assert.equal(classifyAuthBlob("error: GEMINI_API_KEY not found"), "no auth method configured");
});

test("classifyAuthBlob: detects quota exhausted", () => {
  assert.equal(classifyAuthBlob("RESOURCE_EXHAUSTED: quota exceeded"), "quota exhausted");
});

test("classifyAuthBlob: detects 403 / forbidden", () => {
  assert.equal(classifyAuthBlob("HTTP 403 forbidden"), "auth rejected (403)");
  assert.equal(classifyAuthBlob("permission denied"), "auth rejected (403)");
});

test("classifyAuthBlob: detects model unavailable (added in 0.5.0)", () => {
  assert.equal(classifyAuthBlob("ModelNotFoundError: gemini-3.1-pro"), "model unavailable");
  assert.equal(classifyAuthBlob("the model is not available for this account"), "model unavailable");
  assert.equal(classifyAuthBlob("invalid model id"), "model unavailable");
});

test("classifyAuthBlob: returns null for unrelated errors", () => {
  assert.equal(classifyAuthBlob("network connection refused"), null);
  assert.equal(classifyAuthBlob(""), null);
});

test("compareVersions", () => {
  assert.equal(compareVersions("0.39.1", "0.30.0"), 1);
  assert.equal(compareVersions("0.30.0", "0.30.0"), 0);
  assert.equal(compareVersions("0.29.0", "0.30.0"), -1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("0.39.1-rc.2", "0.39.1"), 0); // pre-release stripped
});

test("checkMinVersion: ok for current Gemini CLI shape", () => {
  const r = checkMinVersion("0.39.1");
  assert.equal(r.ok, true);
  assert.equal(r.current, "0.39.1");
});

test("checkMinVersion: fails clearly for old version", () => {
  const r = checkMinVersion("0.20.0");
  assert.equal(r.ok, false);
  assert.match(r.reason, /< required/);
});

test("checkMinVersion: handles unparseable string", () => {
  const r = checkMinVersion("totally-not-a-version");
  assert.equal(r.ok, false);
});

test("effectiveModel: honors caller arg, then env, then default", () => {
  assert.equal(effectiveModel("gemini-2.5-pro"), "gemini-2.5-pro");
  // Without setting env, falls back to DEFAULT_MODEL.
  delete process.env.GEMINI_PLUGIN_MODEL;
  assert.equal(effectiveModel(), DEFAULT_MODEL);
  process.env.GEMINI_PLUGIN_MODEL = "custom-model-id";
  assert.equal(effectiveModel(), "custom-model-id");
  delete process.env.GEMINI_PLUGIN_MODEL;
});

test("MIN_GEMINI_VERSION is sane", () => {
  assert.match(MIN_GEMINI_VERSION, /^\d+\.\d+\.\d+$/);
});

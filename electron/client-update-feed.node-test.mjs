import { test } from "node:test";
import assert from "node:assert/strict";
import { clientUpdateFeed } from "./client-update-feed.mjs";

test("routes Windows x64 and Apple silicon to the DoneBot update feeds", () => {
  assert.deepEqual(clientUpdateFeed("win32", "x64"), {
    provider: "generic",
    url: "https://donebot.cn/api/v1/client/updates/windows-x64/",
  });
  assert.deepEqual(clientUpdateFeed("darwin", "arm64"), {
    provider: "generic",
    url: "https://donebot.cn/api/v1/client/updates/macos-arm64/",
  });
});

test("leaves unsupported architectures on their packaged update feed", () => {
  assert.equal(clientUpdateFeed("darwin", "x64"), null);
  assert.equal(clientUpdateFeed("win32", "arm64"), null);
  assert.equal(clientUpdateFeed("linux", "x64"), null);
});

test("accepts an isolated HTTP feed origin without accepting credentials or query data", () => {
  assert.deepEqual(clientUpdateFeed("win32", "x64", "http://127.0.0.1:9090/"), {
    provider: "generic",
    url: "http://127.0.0.1:9090/api/v1/client/updates/windows-x64/",
  });
  assert.equal(clientUpdateFeed("win32", "x64", "https://user:secret@example.test"), null);
  assert.equal(clientUpdateFeed("win32", "x64", "javascript:alert(1)"), null);
});

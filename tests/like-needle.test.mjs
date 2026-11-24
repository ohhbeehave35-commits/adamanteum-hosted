import assert from "node:assert/strict";
import { test } from "node:test";
import { folderPattern, likeNeedle } from "../lib/like-needle.mjs";

test("a percent or underscore in a folder name is that character", () => {
  assert.equal(folderPattern("100%"), "100\\%/");
  assert.equal(likeNeedle("a_b"), "a\\_b");
  assert.equal(folderPattern("Notes"), "Notes/");
});
